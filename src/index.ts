import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { db } from "./db";
import { Relayer, USDC_MINT } from "./relayer";
import { Client } from "./client";
import { WorkflowProcessor } from "./workflow";
import * as fs from "fs";
import * as path from "path";

// Devnet RPC endpoint
const DEVNET_RPC = "https://api.devnet.solana.com";

// Keypair file path
const KEYPAIRS_FILE = path.join(__dirname, "..", "keypairs.json");

interface SavedKeypairs {
  relayer: number[];
  sender: number[];
  recipient: number[];
}

function loadOrGenerateKeypairs(): {
  relayer: Keypair;
  sender: Keypair;
  recipient: Keypair;
} {
  try {
    if (fs.existsSync(KEYPAIRS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYPAIRS_FILE, "utf-8")) as SavedKeypairs;
      console.log("Loaded existing keypairs from keypairs.json\n");
      return {
        relayer: Keypair.fromSecretKey(Uint8Array.from(data.relayer)),
        sender: Keypair.fromSecretKey(Uint8Array.from(data.sender)),
        recipient: Keypair.fromSecretKey(Uint8Array.from(data.recipient)),
      };
    }
  } catch (error) {
    console.log("Could not load keypairs, generating new ones...\n");
  }

  // Generate new keypairs
  const keypairs = {
    relayer: Keypair.generate(),
    sender: Keypair.generate(),
    recipient: Keypair.generate(),
  };

  // Save to file
  const toSave: SavedKeypairs = {
    relayer: Array.from(keypairs.relayer.secretKey),
    sender: Array.from(keypairs.sender.secretKey),
    recipient: Array.from(keypairs.recipient.secretKey),
  };
  fs.writeFileSync(KEYPAIRS_FILE, JSON.stringify(toSave, null, 2));
  console.log("Generated new keypairs and saved to keypairs.json\n");

  return keypairs;
}

async function main() {
  console.log("=== Gasless USDC Remittance Demo ===\n");

  // Create connection to devnet
  const connection = new Connection(DEVNET_RPC, "confirmed");

  // Load or generate keypairs (persisted to keypairs.json)
  const { relayer: relayerKeypair, sender: senderKeypair, recipient: recipientKeypair } =
    loadOrGenerateKeypairs();

  console.log("Keypairs:");
  console.log(`  Relayer:   ${relayerKeypair.publicKey.toBase58()}`);
  console.log(`  Sender:    ${senderKeypair.publicKey.toBase58()}`);
  console.log(`  Recipient: ${recipientKeypair.publicKey.toBase58()}`);
  console.log("");

  // Display required funding information
  const senderAta = getAssociatedTokenAddressSync(USDC_MINT, senderKeypair.publicKey);

  console.log("=== FUNDING REQUIRED ===");
  console.log("To run this demo, please fund the following accounts on devnet:\n");
  console.log("1. Relayer needs SOL for transaction fees:");
  console.log(`   Address: ${relayerKeypair.publicKey.toBase58()}`);
  console.log("   Amount: ~0.01 SOL\n");
  console.log("2. Sender needs USDC to transfer:");
  console.log(`   Wallet: ${senderKeypair.publicKey.toBase58()}`);
  console.log(`   USDC ATA: ${senderAta.toBase58()}`);
  console.log("   Amount: Any amount of devnet USDC\n");
  console.log(`USDC Mint (devnet): ${USDC_MINT.toBase58()}`);
  console.log("");

  // Register users in the database
  db.addUser(senderKeypair.publicKey.toBase58(), "Sender");
  db.addUser(recipientKeypair.publicKey.toBase58(), "Recipient");
  console.log("Users registered in database.\n");

  // Create relayer and client
  const relayer = new Relayer(relayerKeypair, connection);
  const client = new Client(senderKeypair, connection, relayer);

  // Start the workflow processor
  const workflow = new WorkflowProcessor(connection);
  workflow.start(1000); // Process every second

  // Check balances before proceeding
  console.log("Checking balances...\n");

  try {
    const relayerBalance = await connection.getBalance(relayerKeypair.publicKey);
    console.log(`Relayer SOL balance: ${relayerBalance / LAMPORTS_PER_SOL} SOL`);

    if (relayerBalance === 0) {
      console.log("\n⚠️  Relayer has no SOL. Please fund the relayer address above.");
      console.log("Waiting for funding... (checking every 10 seconds)\n");
      await waitForFunding(connection, relayerKeypair.publicKey);
    }

    // Check sender's USDC balance
    try {
      const senderAtaInfo = await getAccount(connection, senderAta);
      console.log(`Sender USDC balance: ${Number(senderAtaInfo.amount) / 1_000_000} USDC`);

      if (senderAtaInfo.amount === BigInt(0)) {
        console.log("\n⚠️  Sender has no USDC. Please fund the sender's USDC ATA above.");
        console.log("Waiting for USDC funding... (checking every 10 seconds)\n");
        await waitForUsdcFunding(connection, senderAta);
      }

      // Get the actual USDC balance for the transfer
      const updatedAtaInfo = await getAccount(connection, senderAta);
      const usdcBalance = Number(updatedAtaInfo.amount) / 1_000_000;

      // Transfer half of the balance
      const transferAmount = Math.floor(usdcBalance / 2 * 100) / 100; // Round to 2 decimals

      if (transferAmount < 0.01) {
        console.log("Not enough USDC to transfer. Please fund with more USDC.");
        workflow.stop();
        return;
      }

      console.log(`\n=== Initiating Transfer ===`);
      console.log(`Amount: ${transferAmount} USDC`);
      console.log(`From: ${senderKeypair.publicKey.toBase58()}`);
      console.log(`To: ${recipientKeypair.publicKey.toBase58()}\n`);

      // Execute the transfer
      const result = await client.transfer(recipientKeypair.publicKey, transferAmount);

      if (result.success) {
        console.log(`\nTransfer initiated successfully!`);
        console.log(`Transaction ID: ${result.transactionId}`);
        console.log("\nWaiting for transaction to finalize...\n");

        // Wait for transaction to complete
        await waitForCompletion(result.transactionId!, 120000);
      } else {
        console.error(`Transfer failed: ${result.error}`);
      }
    } catch (error: any) {
      if (
        error.name === "TokenAccountNotFoundError" ||
        error.message?.includes("could not find account") ||
        error.message?.includes("TokenAccountNotFoundError")
      ) {
        console.log("\n⚠️  Sender's USDC ATA doesn't exist yet.");
        console.log("Please send USDC to the sender's wallet address to create the ATA.");
        console.log("Waiting for USDC funding... (checking every 10 seconds)\n");
        await waitForUsdcFunding(connection, senderAta);

        // Retry the main function after funding
        workflow.stop();
        await main();
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error("Error during demo:", error);
  }

  // Keep the workflow running for a bit to process the transaction
  console.log("Workflow will continue running for 60 more seconds...\n");
  await new Promise((resolve) => setTimeout(resolve, 60000));

  // Stop the workflow
  workflow.stop();

  // Print final transaction status
  console.log("\n=== Final Transaction States ===");
  const allTx = db.getAllTransactions();
  for (const tx of allTx) {
    console.log(`Transaction: ${tx.signature.slice(0, 30)}...`);
    console.log(`  Status: ${tx.status}`);
    console.log(`  Amount: ${Number(tx.amount) / 1_000_000} USDC`);
    console.log(`  Sender: ${tx.sender}`);
    console.log(`  Recipient: ${tx.recipient}`);
  }

  console.log("\nDemo complete!");
}

async function waitForFunding(
  connection: Connection,
  address: PublicKey,
  minBalance: number = 0.001 * LAMPORTS_PER_SOL
): Promise<void> {
  while (true) {
    const balance = await connection.getBalance(address);
    if (balance >= minBalance) {
      console.log(`✓ Relayer funded with ${balance / LAMPORTS_PER_SOL} SOL`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

async function waitForUsdcFunding(
  connection: Connection,
  ata: PublicKey
): Promise<void> {
  while (true) {
    try {
      const ataInfo = await getAccount(connection, ata);
      if (ataInfo.amount > BigInt(0)) {
        console.log(`✓ Sender funded with ${Number(ataInfo.amount) / 1_000_000} USDC`);
        return;
      }
    } catch {
      // ATA doesn't exist yet, keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

async function waitForCompletion(transactionId: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    const tx = db.getTransaction(transactionId);
    if (!tx) {
      console.log("Transaction not found in database");
      return;
    }

    if (tx.status === "FINALIZED") {
      console.log("✓ Transaction finalized successfully!");
      return;
    }

    if (tx.status === "FAILED") {
      console.log("✗ Transaction failed");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  console.log("Timeout waiting for transaction completion");
}

main().catch(console.error);
