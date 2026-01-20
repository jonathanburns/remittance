## Code Sample:

The following code is for demo purposes only. It shows how you can facilitate gasless USDC transfers for a remittance app built on Solana.

The client has a “transfer” function that will:

- Create instructions for an idempotent ATA creation + a transfer instruction, sign the transaction, and send it to the relayer. The relayer returns the tx_id.
- Poll a “status” endpoint which the relayer provides, passing in the transaction hash.
- Log “success” or “failure” when the transaction reaches a terminal state.

For demo purposes, the relayer is simply a function in the file. In a real deployment, this would be an API call. The relayTransaction function will:

- Perform a variety of checks to ensure that the transaction is well formed.
- Signs the transaction with the relayer’s signature, and stores a record of this transaction in the db.
- Returns “success”

For demo purposes, the database is an in-memory JSON object.

There is an asynchronous workflow that runs once per second. It:

- Gathers all transactions that are not in terminal state. For each transaction, it:
  - Submits the transaction if necessary.
  - Updates the transaction status to reflect the on-chain status.
  - Updates the status to FAILED only if we are 100% sure it has failed. (this is important because a user might re-try a failed transaction)

Lastly, there is a function (which would normally be an API) which surfaces the transaction status.  
In a real scenario, you might want to gate this endpoint so that only the sending user can call it.

---

## Details:

The client has a private key. It has a “send transaction” function that takes, as input, the recipient, and USDC amount. It:

- Generates a transaction with two instructions
- Idempotent create of the recipient ATA (associated token account)
- The transfer instruction between the two ATAs
- Include the known gas-relayer address as the fee payer.
- Signs the transaction and sends it to the relayer. It includes the lastValidBlockheight in this call.
- Once it receives a “success” from the relayer, it kicks off an async function which periodically calls “get_status” endpoint from the relayer every 5 seconds, passing in the transaction_hash.
- If the response status CONFIRMED or FINALIZED, it prints “transaction succeeded!”, and quits the loop.

The server “send transaction” endpoint:

For the purposes of the demo, the DB will just be an in-mem datastore.

Perform pre-checks:

- Check that there are exactly two instructions.
- Fee payer == relayer pubkey (and required signer)
- Transaction has a recent blockhash
- No extra writable/signers beyond what we expect (prevents sneaky instruction combos)

Second instruction:

- Verify sender and recipient are both accounts in our internal db [we’ll hard code this for the demo]
- Send sender/recipient address “is_compliant” function, which just returns true in the demo.
- Must be SPL token TransferChecked
- Source ATA owner == sender (or delegated authority if you support that; otherwise reject)
- Destination ATA matches recipient’s ATA
- Verify the token is USDC

First instruction:

- Must be Associated Token Account Program create idempotent
- Must target the recipient ATA for USDC

Signatures:

- Ensure the sender signature is present
- Ensure relayer signature is not present yet
- Sign the transaction
- If the transaction doesn’t already exist in the DB, store it, keyed by the transaction signature.
- Status should be “created”, and include lastValidBlockheight
- Return transaction_id

---

## Workflow Loop:

Get all transactions in NOT in FINALIZED or FAILED state. For each:

- tx getSignatureStatuses
  - If null
    - If isBlockhashValid (i.e. can we submit/re-submit it?)
      - Broadcast the tx on-chain
      - If statue == CREATED
        - Set STATE = SUBMITTED
  - else:
    - // confirm that the transaction is not included on-chain
    - getEpochInfo({ commitment: "finalized" }) // tells us the most recent finalized block
    - if getEpochInfo.blockHeight < lastValidBlockheight
      - return
    - getSignatureStatuses (with history = true)
      - If not null, return
    - Call getTransaction (of any commitment)
      - If not null, return
    - Set state = FAILED
    - Return

- Get confirmationStatus
  - If status == “processed”
    - Set state = PROCESSED
  - If status == “confirmed”
    - Set state = CONFIRMED
  - If status == “finalized”
    - Call sendReceipt function (just logs for now)
    - Set state = FINALIZED
