import { Connection, Transaction } from "@solana/web3.js";
import { db, TransactionStatus, TransactionRecord } from "./db";
import bs58 from "bs58";

export class WorkflowProcessor {
  private connection: Connection;
  private running: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  start(intervalMs: number = 1000): void {
    if (this.running) {
      console.log("[Workflow] Already running");
      return;
    }

    this.running = true;
    console.log(`[Workflow] Started processing loop (interval: ${intervalMs}ms)`);

    this.intervalId = setInterval(async () => {
      await this.processTransactions();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log("[Workflow] Stopped processing loop");
  }

  private async processTransactions(): Promise<void> {
    const transactions = db.getNonTerminalTransactions();

    for (const tx of transactions) {
      try {
        await this.processTransaction(tx);
      } catch (error) {
        console.error(`[Workflow] Error processing tx ${tx.signature.slice(0, 20)}...:`, error);
      }
    }
  }

  private async processTransaction(tx: TransactionRecord): Promise<void> {
    // Deserialize the transaction to get the signature
    const transaction = Transaction.from(
      Buffer.from(tx.serializedTransaction, "base64")
    );

    // Get the first signature (relayer's signature, which is the transaction ID on-chain)
    const signatureBuffer = transaction.signature;
    if (!signatureBuffer) {
      console.error(`[Workflow] Transaction has no signature: ${tx.signature.slice(0, 20)}...`);
      return;
    }
    const onChainSignature = bs58.encode(signatureBuffer);

    // Check signature status
    const statuses = await this.connection.getSignatureStatuses([onChainSignature]);
    const status = statuses.value[0];

    if (status === null) {
      // Transaction not found on-chain
      await this.handleNullStatus(tx, transaction, onChainSignature);
    } else {
      // Transaction found on-chain, update status
      await this.handleExistingStatus(tx, status.confirmationStatus);
    }
  }

  private async handleNullStatus(
    tx: TransactionRecord,
    transaction: Transaction,
    onChainSignature: string
  ): Promise<void> {
    // Check if blockhash is still valid
    const isBlockhashValid = await this.connection.isBlockhashValid(
      transaction.recentBlockhash!,
      { commitment: "finalized" }
    );

    if (isBlockhashValid.value) {
      // Blockhash is still valid, submit/resubmit the transaction
      try {
        console.log(`[Workflow] Submitting tx ${onChainSignature.slice(0, 20)}...`);

        const rawTransaction = transaction.serialize();
        await this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        if (tx.status === TransactionStatus.CREATED) {
          db.updateTransactionStatus(tx.signature, TransactionStatus.SUBMITTED);
          console.log(`[Workflow] Tx ${onChainSignature.slice(0, 20)}... status: SUBMITTED`);
        }
      } catch (error: any) {
        // Transaction might have already been processed
        if (error.message?.includes("already been processed")) {
          console.log(`[Workflow] Tx ${onChainSignature.slice(0, 20)}... already processed`);
        } else {
          console.error(`[Workflow] Error submitting tx:`, error.message || error);
        }
      }
    } else {
      // Blockhash is no longer valid, need to check if transaction truly failed
      await this.handleExpiredBlockhash(tx, onChainSignature);
    }
  }

  private async handleExpiredBlockhash(
    tx: TransactionRecord,
    onChainSignature: string
  ): Promise<void> {
    // Get epoch info to check finalized block height
    const epochInfo = await this.connection.getEpochInfo("finalized");
    const currentBlockHeight = epochInfo.blockHeight ?? 0;

    if (currentBlockHeight < tx.lastValidBlockHeight) {
      // The finalized chain hasn't caught up yet, wait
      console.log(
        `[Workflow] Waiting for finalized chain to catch up (current: ${currentBlockHeight}, lastValid: ${tx.lastValidBlockHeight})`
      );
      return;
    }

    // Check signature status with history search
    const statusesWithHistory = await this.connection.getSignatureStatuses(
      [onChainSignature],
      { searchTransactionHistory: true }
    );

    if (statusesWithHistory.value[0] !== null) {
      // Transaction was found in history, don't mark as failed
      console.log(`[Workflow] Tx ${onChainSignature.slice(0, 20)}... found in history`);
      return;
    }

    // Final check: try to get the transaction directly
    try {
      const txResult = await this.connection.getTransaction(onChainSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (txResult !== null) {
        // Transaction exists, don't mark as failed
        console.log(`[Workflow] Tx ${onChainSignature.slice(0, 20)}... found via getTransaction`);
        return;
      }
    } catch (error) {
      // Ignore errors, proceed to mark as failed
    }

    // Transaction is definitively failed
    db.updateTransactionStatus(tx.signature, TransactionStatus.FAILED);
    console.log(`[Workflow] Tx ${onChainSignature.slice(0, 20)}... status: FAILED (blockhash expired)`);
  }

  private async handleExistingStatus(
    tx: TransactionRecord,
    confirmationStatus: string | null | undefined
  ): Promise<void> {
    if (!confirmationStatus) return;

    switch (confirmationStatus) {
      case "processed":
        if (tx.status !== TransactionStatus.PROCESSED) {
          db.updateTransactionStatus(tx.signature, TransactionStatus.PROCESSED);
          console.log(`[Workflow] Tx ${tx.signature.slice(0, 20)}... status: PROCESSED`);
        }
        break;

      case "confirmed":
        if (
          tx.status !== TransactionStatus.CONFIRMED &&
          tx.status !== TransactionStatus.FINALIZED
        ) {
          db.updateTransactionStatus(tx.signature, TransactionStatus.CONFIRMED);
          console.log(`[Workflow] Tx ${tx.signature.slice(0, 20)}... status: CONFIRMED`);
        }
        break;

      case "finalized":
        if (tx.status !== TransactionStatus.FINALIZED) {
          db.updateTransactionStatus(tx.signature, TransactionStatus.FINALIZED);
          this.sendReceipt(tx);
          console.log(`[Workflow] Tx ${tx.signature.slice(0, 20)}... status: FINALIZED`);
        }
        break;
    }
  }

  private sendReceipt(tx: TransactionRecord): void {
    // For demo purposes, just log the receipt
    console.log(`[Workflow] Receipt sent for transaction:`);
    console.log(`  - Sender: ${tx.sender}`);
    console.log(`  - Recipient: ${tx.recipient}`);
    console.log(`  - Amount: ${Number(tx.amount) / 1_000_000} USDC`);
    console.log(`  - Status: ${tx.status}`);
  }
}
