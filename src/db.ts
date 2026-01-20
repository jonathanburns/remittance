import { PublicKey } from "@solana/web3.js";

export enum TransactionStatus {
  CREATED = "CREATED",
  SUBMITTED = "SUBMITTED",
  PROCESSED = "PROCESSED",
  CONFIRMED = "CONFIRMED",
  FINALIZED = "FINALIZED",
  FAILED = "FAILED",
}

export interface TransactionRecord {
  signature: string;
  serializedTransaction: string;
  sender: string;
  recipient: string;
  amount: bigint;
  lastValidBlockHeight: number;
  status: TransactionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRecord {
  publicKey: string;
  name: string;
}

class Database {
  private transactions: Map<string, TransactionRecord> = new Map();
  private users: Map<string, UserRecord> = new Map();

  addUser(publicKey: string, name: string): void {
    this.users.set(publicKey, { publicKey, name });
  }

  getUser(publicKey: string): UserRecord | undefined {
    return this.users.get(publicKey);
  }

  isUserRegistered(publicKey: string): boolean {
    return this.users.has(publicKey);
  }

  isCompliant(publicKey: string): boolean {
    // For demo purposes, always return true
    return true;
  }

  addTransaction(record: TransactionRecord): void {
    if (!this.transactions.has(record.signature)) {
      this.transactions.set(record.signature, record);
    }
  }

  getTransaction(signature: string): TransactionRecord | undefined {
    return this.transactions.get(signature);
  }

  updateTransactionStatus(signature: string, status: TransactionStatus): void {
    const record = this.transactions.get(signature);
    if (record) {
      record.status = status;
      record.updatedAt = new Date();
    }
  }

  getNonTerminalTransactions(): TransactionRecord[] {
    const terminalStates = [TransactionStatus.FINALIZED, TransactionStatus.FAILED];
    return Array.from(this.transactions.values()).filter(
      (tx) => !terminalStates.includes(tx.status)
    );
  }

  getAllTransactions(): TransactionRecord[] {
    return Array.from(this.transactions.values());
  }
}

export const db = new Database();
