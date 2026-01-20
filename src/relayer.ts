import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { db, TransactionStatus, TransactionRecord } from "./db";

// USDC mint address on devnet
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// TransferChecked instruction discriminator
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

// Create idempotent ATA instruction discriminator
const CREATE_IDEMPOTENT_ATA_DISCRIMINATOR = 1;

export class Relayer {
  private keypair: Keypair;
  // Connection stored for potential future use (e.g., balance checks)
  private _connection: Connection;

  constructor(keypair: Keypair, connection: Connection) {
    this.keypair = keypair;
    this._connection = connection;
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async relayTransaction(
    serializedTransaction: string,
    lastValidBlockHeight: number
  ): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    try {
      // Deserialize the transaction
      const transactionBuffer = Buffer.from(serializedTransaction, "base64");
      const transaction = Transaction.from(transactionBuffer);

      // Validate the transaction
      const validationResult = await this.validateTransaction(transaction);
      if (!validationResult.valid) {
        return { success: false, error: validationResult.error };
      }

      // Sign the transaction with the relayer's key
      transaction.partialSign(this.keypair);

      // Get the transaction signature (first signature is the fee payer, which is the relayer)
      const signature = transaction.signature?.toString("base64");
      if (!signature) {
        return { success: false, error: "Failed to get transaction signature" };
      }

      // Use the sender's signature as the transaction ID (more unique)
      const senderSignature = transaction.signatures[1]?.signature;
      if (!senderSignature) {
        return { success: false, error: "Sender signature not found" };
      }
      const transactionId = Buffer.from(senderSignature).toString("base64");

      // Check if transaction already exists
      const existingTx = db.getTransaction(transactionId);
      if (existingTx) {
        return { success: true, transactionId };
      }

      // Store the transaction in the database
      const record: TransactionRecord = {
        signature: transactionId,
        serializedTransaction: transaction.serialize().toString("base64"),
        sender: validationResult.sender!,
        recipient: validationResult.recipient!,
        amount: validationResult.amount!,
        lastValidBlockHeight,
        status: TransactionStatus.CREATED,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      db.addTransaction(record);

      console.log(`[Relayer] Transaction accepted: ${transactionId.slice(0, 20)}...`);
      return { success: true, transactionId };
    } catch (error) {
      console.error("[Relayer] Error processing transaction:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async validateTransaction(
    transaction: Transaction
  ): Promise<{
    valid: boolean;
    error?: string;
    sender?: string;
    recipient?: string;
    amount?: bigint;
  }> {
    const instructions = transaction.instructions;

    // Check that there are exactly two instructions
    if (instructions.length !== 2) {
      return {
        valid: false,
        error: `Expected 2 instructions, got ${instructions.length}`,
      };
    }

    // Check fee payer is the relayer
    if (!transaction.feePayer?.equals(this.keypair.publicKey)) {
      return {
        valid: false,
        error: "Fee payer must be the relayer",
      };
    }

    // Validate first instruction (create idempotent ATA)
    const createAtaResult = this.validateCreateAtaInstruction(instructions[0]);
    if (!createAtaResult.valid) {
      return createAtaResult;
    }

    // Get recipient from create ATA instruction
    const recipient = getRecipientFromCreateAta(instructions[0]);

    // Validate second instruction (transfer checked)
    const transferResult = this.validateTransferInstruction(instructions[1], recipient);
    if (!transferResult.valid) {
      return transferResult;
    }

    // Verify the ATA creation targets the recipient's ATA
    const recipientAta = getAssociatedTokenAddressSync(
      USDC_MINT,
      new PublicKey(transferResult.recipient!)
    );
    if (!createAtaResult.targetAta?.equals(recipientAta)) {
      return {
        valid: false,
        error: "ATA creation must target recipient's USDC ATA",
      };
    }

    // Verify sender and recipient are registered users
    if (!db.isUserRegistered(transferResult.sender!)) {
      return {
        valid: false,
        error: "Sender is not a registered user",
      };
    }
    if (!db.isUserRegistered(transferResult.recipient!)) {
      return {
        valid: false,
        error: "Recipient is not a registered user",
      };
    }

    // Check compliance
    if (!db.isCompliant(transferResult.sender!)) {
      return {
        valid: false,
        error: "Sender is not compliant",
      };
    }
    if (!db.isCompliant(transferResult.recipient!)) {
      return {
        valid: false,
        error: "Recipient is not compliant",
      };
    }

    // Check that sender signature is present
    const senderPubkey = new PublicKey(transferResult.sender!);
    const senderSignatureInfo = transaction.signatures.find((sig) =>
      sig.publicKey.equals(senderPubkey)
    );
    if (!senderSignatureInfo?.signature) {
      return {
        valid: false,
        error: "Sender signature is missing",
      };
    }

    // Check that relayer signature is NOT present yet
    const relayerSignatureInfo = transaction.signatures.find((sig) =>
      sig.publicKey.equals(this.keypair.publicKey)
    );
    if (relayerSignatureInfo?.signature) {
      return {
        valid: false,
        error: "Relayer signature should not be present yet",
      };
    }

    // Validate no unexpected signers or writable accounts
    const expectedSigners = new Set([
      this.keypair.publicKey.toBase58(),
      transferResult.sender!,
    ]);
    for (const sig of transaction.signatures) {
      if (!expectedSigners.has(sig.publicKey.toBase58())) {
        return {
          valid: false,
          error: `Unexpected signer: ${sig.publicKey.toBase58()}`,
        };
      }
    }

    return {
      valid: true,
      sender: transferResult.sender,
      recipient: transferResult.recipient,
      amount: transferResult.amount,
    };
  }

  private validateCreateAtaInstruction(instruction: TransactionInstruction): {
    valid: boolean;
    error?: string;
    targetAta?: PublicKey;
  } {
    // Check program ID is Associated Token Program
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      return {
        valid: false,
        error: "First instruction must be from Associated Token Program",
      };
    }

    // Check instruction data for create idempotent (discriminator = 1)
    if (
      instruction.data.length !== 1 ||
      instruction.data[0] !== CREATE_IDEMPOTENT_ATA_DISCRIMINATOR
    ) {
      return {
        valid: false,
        error: "First instruction must be create idempotent ATA",
      };
    }

    // Account order for create idempotent ATA:
    // 0: Funding account (fee payer)
    // 1: ATA to create
    // 2: Wallet address (owner)
    // 3: Mint
    // 4: System program
    // 5: Token program
    if (instruction.keys.length < 6) {
      return {
        valid: false,
        error: "Invalid create ATA instruction accounts",
      };
    }

    const targetAta = instruction.keys[1].pubkey;
    const mint = instruction.keys[3].pubkey;

    // Verify mint is USDC
    if (!mint.equals(USDC_MINT)) {
      return {
        valid: false,
        error: "ATA must be for USDC token",
      };
    }

    return { valid: true, targetAta };
  }

  private validateTransferInstruction(
    instruction: TransactionInstruction,
    recipient: PublicKey
  ): {
    valid: boolean;
    error?: string;
    sender?: string;
    recipient?: string;
    amount?: bigint;
  } {
    // Check program ID is Token Program
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      return {
        valid: false,
        error: "Second instruction must be from Token Program",
      };
    }

    // Check instruction data for transfer checked (discriminator = 12)
    if (instruction.data.length < 9 || instruction.data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) {
      return {
        valid: false,
        error: "Second instruction must be TransferChecked",
      };
    }

    // Parse amount from instruction data (bytes 1-8, little endian)
    const amount = instruction.data.readBigUInt64LE(1);

    // Account order for TransferChecked:
    // 0: Source ATA
    // 1: Mint
    // 2: Destination ATA
    // 3: Source owner/authority
    if (instruction.keys.length < 4) {
      return {
        valid: false,
        error: "Invalid TransferChecked instruction accounts",
      };
    }

    const sourceAta = instruction.keys[0].pubkey;
    const mint = instruction.keys[1].pubkey;
    const destAta = instruction.keys[2].pubkey;
    const sourceOwner = instruction.keys[3].pubkey;

    // Verify mint is USDC
    if (!mint.equals(USDC_MINT)) {
      return {
        valid: false,
        error: "Transfer must be USDC token",
      };
    }

    // Verify source ATA matches sender's expected ATA
    const expectedSourceAta = getAssociatedTokenAddressSync(USDC_MINT, sourceOwner);
    if (!sourceAta.equals(expectedSourceAta)) {
      return {
        valid: false,
        error: "Source ATA does not match sender's USDC ATA",
      };
    }

    // Verify destination ATA matches recipient's expected ATA
    const expectedDestAta = getAssociatedTokenAddressSync(USDC_MINT, recipient);
    if (!destAta.equals(expectedDestAta)) {
      return {
        valid: false,
        error: "Destination ATA does not match recipient's USDC ATA",
      };
    }

    return {
      valid: true,
      sender: sourceOwner.toBase58(),
      recipient: recipient.toBase58(),
      amount,
    };
  }

  async getTransactionStatus(transactionId: string): Promise<{
    status: TransactionStatus | null;
    error?: string;
  }> {
    const record = db.getTransaction(transactionId);
    if (!record) {
      return { status: null, error: "Transaction not found" };
    }
    return { status: record.status };
  }
}

// Helper to get recipient from create ATA instruction
export function getRecipientFromCreateAta(instruction: TransactionInstruction): PublicKey {
  // Account order for create idempotent ATA:
  // 0: Funding account (fee payer)
  // 1: ATA to create
  // 2: Wallet address (owner) <- this is the recipient
  return instruction.keys[2].pubkey;
}
