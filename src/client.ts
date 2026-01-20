import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Relayer, USDC_MINT } from "./relayer";
import { TransactionStatus } from "./db";

// USDC has 6 decimals
const USDC_DECIMALS = 6;

export class Client {
  private keypair: Keypair;
  private connection: Connection;
  private relayer: Relayer;

  constructor(keypair: Keypair, connection: Connection, relayer: Relayer) {
    this.keypair = keypair;
    this.connection = connection;
    this.relayer = relayer;
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async transfer(
    recipient: PublicKey,
    amountUsdc: number
  ): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    try {
      console.log(`[Client] Initiating transfer of ${amountUsdc} USDC to ${recipient.toBase58()}`);

      // Get the latest blockhash
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("finalized");

      // Calculate amount in smallest units (6 decimals for USDC)
      const amount = BigInt(Math.floor(amountUsdc * 10 ** USDC_DECIMALS));

      // Get sender and recipient ATAs
      const senderAta = getAssociatedTokenAddressSync(USDC_MINT, this.keypair.publicKey);
      const recipientAta = getAssociatedTokenAddressSync(USDC_MINT, recipient);

      // Create the transaction with two instructions
      const transaction = new Transaction();

      // 1. Idempotent create of recipient's ATA
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        this.relayer.publicKey, // payer (relayer pays)
        recipientAta, // ata
        recipient, // owner
        USDC_MINT // mint
      );
      transaction.add(createAtaIx);

      // 2. Transfer USDC
      const transferIx = createTransferCheckedInstruction(
        senderAta, // source
        USDC_MINT, // mint
        recipientAta, // destination
        this.keypair.publicKey, // owner
        amount, // amount
        USDC_DECIMALS // decimals
      );
      transaction.add(transferIx);

      // Set fee payer to relayer
      transaction.feePayer = this.relayer.publicKey;
      transaction.recentBlockhash = blockhash;

      // Sign with sender's key (partial sign)
      transaction.partialSign(this.keypair);

      // Serialize and send to relayer
      const serializedTransaction = transaction
        .serialize({ requireAllSignatures: false })
        .toString("base64");

      console.log(`[Client] Sending transaction to relayer...`);

      // Send to relayer
      const result = await this.relayer.relayTransaction(
        serializedTransaction,
        lastValidBlockHeight
      );

      if (!result.success) {
        console.error(`[Client] Relayer rejected transaction: ${result.error}`);
        return { success: false, error: result.error };
      }

      console.log(`[Client] Transaction accepted by relayer: ${result.transactionId?.slice(0, 20)}...`);

      // Start polling for status
      this.pollTransactionStatus(result.transactionId!);

      return { success: true, transactionId: result.transactionId };
    } catch (error) {
      console.error("[Client] Error creating transfer:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async pollTransactionStatus(transactionId: string): Promise<void> {
    const pollInterval = 5000; // 5 seconds
    const maxAttempts = 60; // 5 minutes max

    let attempts = 0;
    const poll = async () => {
      attempts++;

      const statusResult = await this.relayer.getTransactionStatus(transactionId);

      if (statusResult.status === null) {
        console.log(`[Client] Transaction not found: ${transactionId.slice(0, 20)}...`);
        return;
      }

      console.log(`[Client] Transaction status: ${statusResult.status}`);

      if (
        statusResult.status === TransactionStatus.CONFIRMED ||
        statusResult.status === TransactionStatus.FINALIZED
      ) {
        console.log(`[Client] ✓ Transaction succeeded! Status: ${statusResult.status}`);
        return;
      }

      if (statusResult.status === TransactionStatus.FAILED) {
        console.log(`[Client] ✗ Transaction failed!`);
        return;
      }

      if (attempts >= maxAttempts) {
        console.log(`[Client] Stopped polling after ${maxAttempts} attempts`);
        return;
      }

      // Continue polling
      setTimeout(poll, pollInterval);
    };

    // Start polling after initial delay
    setTimeout(poll, pollInterval);
  }
}
