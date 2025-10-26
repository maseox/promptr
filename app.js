require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const { Pool } = require('pg');
const { OpenAI } = require('openai');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// === Rate Limiting (scalabilité) ===
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,  // ← Forcé en nombre
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in 1 minute.' }
});
app.use(limiter);

// === Winston Logger ===
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: process.env.LOG_FILE || 'logs/app.log' })
  ]
});

// === PostgreSQL ===
let pool = null;
let dbAvailable = false;
try {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    dbAvailable = true;
  } else {
    logger.warn('DATABASE_URL not set. DB logging disabled.');
  }
} catch (e) {
  logger.error('❌ Failed to initialize DB pool', e.message || e);
}

async function initDB() {
  if (!pool) {
    logger.warn('Skipping DB init: no DATABASE_URL.');
    return;
  }
  let client = null;
  try {
    client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type_requete VARCHAR(50),
        details_json JSONB,
        statut VARCHAR(20)
      );
    `);
    logger.info('✅ Logs DB ready');
    dbAvailable = true;
  } catch (err) {
    logger.error('❌ DB init', err);
    dbAvailable = false;
  } finally {
    if (client) client.release();
  }
}
initDB();

async function logToDB(type, details, statut = 'success') {
  if (!pool || !dbAvailable) {
    return; // DB disabled/unavailable; skip logging silently
  }
  try {
    await pool.query(
      'INSERT INTO logs (type_requete, details_json, statut) VALUES ($1, $2, $3)',
      [type, JSON.stringify(details), statut]
    );
  } catch (err) {
    logger.error('❌ DB log', err);
  }
}

// === OpenAI ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Solana Connection ===
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta'; // ou 'devnet'
// Allow overriding the RPC endpoint via env var (useful for paid providers / keys)
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://api.${SOLANA_NETWORK}.solana.com`;
// Optional RPC API key for providers like Helius; used as header if not present in URL
const SOLANA_RPC_API_KEY = process.env.SOLANA_RPC_API_KEY || process.env.HELIUS_API_KEY || process.env.SOLANA_API_KEY || null;

function buildRpcHeaders() {
  const headers = {};
  if (SOLANA_RPC_API_KEY) {
    headers['api-key'] = SOLANA_RPC_API_KEY;
    headers['x-api-key'] = SOLANA_RPC_API_KEY;
  }
  return Object.keys(headers).length ? headers : undefined;
}

logger.info('🔗 Solana RPC configured', { 
  url: SOLANA_RPC_URL.includes('api-key') 
    ? SOLANA_RPC_URL.split('?')[0] + '?api-key=***' 
    : SOLANA_RPC_URL,
  network: SOLANA_NETWORK,
  auth: SOLANA_RPC_URL.includes('api-key') ? 'query-param' : (SOLANA_RPC_API_KEY ? 'header' : 'none')
});
const connection = new Connection(SOLANA_RPC_URL, { httpHeaders: buildRpcHeaders() });

// USDC Mint (mainnet, synced with the frontend)
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Receiver synced with the frontend
const X402_RECEIVER_ADDRESS = '3LrVwGYoqUgvwUadaCrkpqBNqkgVcWpac7CYM99KbQHk';
// Default facilitator (PayAI) if not provided in env
const FACILITATOR_URL = (process.env.X402_FACILITATOR_API_URL && process.env.X402_FACILITATOR_API_URL.trim()) || 'https://facilitator.payai.network';

// USDC payment verification
async function verifyUSDCTransfer(txId, senderAddress) {
  try {
  logger.info('📝 Verifying transaction', { txId, senderAddress });
    // helper sleep
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Step 1: check signature status first (cheaper / less rate-limited)
    // If the tx is not at least 'confirmed', return null (inconclusive) so caller
    // can retry with backoff. If the status indicates an error, return false.
    let sigStatus = null;
    try {
      const statuses = await connection.getSignatureStatuses([txId], { searchTransactionHistory: true });
      sigStatus = statuses && statuses.value && statuses.value[0];
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('429') || /Too Many Requests/i.test(msg) || msg.includes('rate limit')) {
        logger.warn('RPC rate limited on getSignatureStatuses', { err: msg });
        return null;
      }
  logger.error('❌ getSignatureStatuses error', err?.message || err);
      return null;
    }

    if (!sigStatus) {
      // Not indexed yet / unknown -> retry later
      logger.info('getSignatureStatuses returned null (not yet available)');
      return null;
    }

    if (sigStatus.err) {
      // transaction failed on-chain
      logger.error('❌ Transaction error according to signature status', sigStatus.err);
      return false;
    }

    // confirmationStatus can be 'processed'|'confirmed'|'finalized'
    if (!sigStatus.confirmationStatus || (sigStatus.confirmationStatus !== 'confirmed' && sigStatus.confirmationStatus !== 'finalized')) {
      // still processing -> try later
      logger.info('Signature not yet confirmed/finalized', { confirmationStatus: sigStatus.confirmationStatus });
      return null;
    }

    // Step 2: now fetch parsed transaction once (we're confirmed so parser should be available)
    let tx = null;
    try {
      tx = await connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 });
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('429') || /Too Many Requests/i.test(msg) || msg.includes('rate limit')) {
        logger.warn('RPC rate limited on getParsedTransaction', { err: msg });
        return null;
      }
  logger.error('❌ getParsedTransaction error', msg);
      return null;
    }
    if (!tx) {
      logger.info('getParsedTransaction returned null despite confirmed signature; trying RPC getTransaction fallback');
      try {
        const rpcBody = { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [txId, { encoding: 'jsonParsed', commitment: 'confirmed' }] };
  const rpcResp = await axios.post(SOLANA_RPC_URL, rpcBody, { headers: { 'Content-Type': 'application/json', ...(buildRpcHeaders() || {}) } });
        if (rpcResp?.data?.error) {
          logger.warn('RPC getTransaction returned error', { error: rpcResp.data.error });
        } else if (rpcResp?.data?.result) {
          tx = rpcResp.data.result;
          logger.info('RPC getTransaction fallback succeeded', { txId });
        }
      } catch (rpcErr) {
        const msg = rpcErr?.message || rpcErr;
        if (msg.includes('429') || /Too Many Requests/i.test(msg) || msg.includes('rate limit')) {
          logger.warn('RPC rate limited on getTransaction fallback', { err: msg });
          return null;
        }
        logger.warn('RPC getTransaction fallback failed', { err: msg });
      }
      if (!tx) return null;
    }
    if (tx.meta?.err) {
      logger.error('❌ Transaction failed', tx.meta.err);
      return false;
    }
    // montant attendu
    const amountUSDC = parseFloat(process.env.X402_AMOUNT_USDC || '0.001'); // use env if set
    const amountAtomic = BigInt(Math.floor(amountUSDC * 1_000_000)); // 6 decimals -> atomic units
    const receiver = X402_RECEIVER_ADDRESS;

    // compute receiver's ATA for the USDC mint
    let receiverATA = null;
    try {
      receiverATA = (await getAssociatedTokenAddress(new PublicKey(USDC_MINT), new PublicKey(receiver))).toString();
    } catch (e) {
      logger.warn('Unable to compute receiver ATA', e.message || e);
    }

    // compute sender ATA to allow instruction-matching where parsed info uses ATA pubkeys
    let senderATA = null;
    try {
      senderATA = (await getAssociatedTokenAddress(new PublicKey(USDC_MINT), new PublicKey(senderAddress))).toString();
    } catch (e) {
      logger.warn('Unable to compute sender ATA', e.message || e);
    }

    // Robust verification: check token balance diffs in postTokenBalances vs preTokenBalances
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];

  logger.info('debug token balances', { pre, post, receiverATA });

    // helper to resolve account pubkey from token balance entry
    const resolveAccountPubkey = (entry) => {
      if (!entry) return null;
      if (entry.pubkey) return entry.pubkey;
      if (entry.accountIndex != null) {
        const keyEntry = tx.transaction.message.accountKeys[entry.accountIndex];
        if (!keyEntry) return null;
        return typeof keyEntry === 'string' ? keyEntry : keyEntry.pubkey || null;
      }
      return entry.accountId || entry.account || null;
    };

    for (const p of post) {
      if (!p || p.mint !== USDC_MINT) continue;
      try {
        const accountPubkey = resolveAccountPubkey(p);
        const ownerField = p.owner || null;
        const postAmount = BigInt(p.uiTokenAmount?.amount || '0');

        // Decide which pre-entry to compare against
        let preEntry = null;
        if (ownerField && ownerField === receiver) {
          preEntry = pre.find(x => (x.owner || null) === ownerField) || { uiTokenAmount: { amount: '0' } };
        } else if (receiverATA && (accountPubkey === receiverATA || accountPubkey === receiver)) {
          preEntry = pre.find(x => resolveAccountPubkey(x) === accountPubkey) || { uiTokenAmount: { amount: '0' } };
        } else if (accountPubkey && accountPubkey === receiver) {
          preEntry = pre.find(x => resolveAccountPubkey(x) === accountPubkey) || { uiTokenAmount: { amount: '0' } };
        } else {
          // Not a receiver-related post entry
          continue;
        }

        const preAmount = BigInt(preEntry.uiTokenAmount?.amount || '0');
        const diff = postAmount - preAmount;
        logger.info('balance diff check', { accountPubkey, ownerField, preAmount: preAmount.toString(), postAmount: postAmount.toString(), diff: diff.toString(), required: amountAtomic.toString() });

        if (diff >= amountAtomic) {
          // optional facilitator check (use configured/default facilitator)
          if (FACILITATOR_URL) {
            try {
              const facUrl = FACILITATOR_URL.replace(/\/$/, '') + '/verify';
              const resp = await axios.post(facUrl, { txId, sender: senderAddress }, { headers: { 'Authorization': process.env.X402_FACILITATOR_API_KEY ? `Bearer ${process.env.X402_FACILITATOR_API_KEY}` : undefined } });
              if (!resp.data.valid) {
                logger.warn('Facilitator: transaction not validated by facilitator', resp.data);
                return false;
              }
            } catch (facErr) {
              logger.warn('Error calling facilitator', facErr.message || facErr);
              // don't fail on facilitator errors; continue with on-chain check
            }
          }

          await logToDB('payment', { txId, sender: senderAddress, receiver, amount: amountUSDC, stablecoin: 'USDC', status: 'confirmed' }, 'success');
          return true;
        }
      } catch (innerErr) {
        logger.error('Error verifying balance entry', innerErr?.message || innerErr);
      }
    }

    // Fallback 1: inspect parsed transfer instructions (direct match by ATA/source)
    const insts = tx.transaction.message.instructions || [];
    logger.info('parsed instructions', { insts });
    for (const inst of insts) {
      if (!inst.parsed) continue;
      if (inst.parsed.type === 'transfer' || inst.parsed.type === 'transferChecked') {
        const info = inst.parsed.info || {};
        const amt = BigInt(info.amount || '0');
        const src = info.source || info.from || info.account || null;
        const dest = info.destination || info.to || info.account || null;
        if (info.mint === USDC_MINT && amt >= amountAtomic) {
          // prefer explicit ATA matching (senderATA -> receiverATA), fallback to owner checks
          if ((senderATA && src === senderATA && (dest === receiverATA || dest === receiver)) ||
              (src === senderAddress && (dest === receiverATA || dest === receiver)) ) {
            await logToDB('payment', { txId, sender: senderAddress, receiver, amount: amountUSDC, stablecoin: 'USDC', status: 'confirmed' }, 'success');
            return true;
          }
        }
      }
    }

    // Additional fallback: check innerInstructions (some RPCs place token transfers there)
    try {
      const inner = tx.meta?.innerInstructions || [];
      logger.info('innerInstructions', { inner });
      for (const slot of inner) {
        for (const inst of slot.instructions || []) {
          if (!inst.parsed) continue;
          const info = inst.parsed.info || {};
          const amt = BigInt(info.amount || '0');
          const dest = info.destination || info.account || info.to;
          if ((inst.parsed.type === 'transfer' || inst.parsed.type === 'transferChecked') && info.mint === USDC_MINT && amt >= amountAtomic) {
            if (dest === receiverATA || dest === receiver) {
              await logToDB('payment', { txId, sender: senderAddress, receiver, amount: amountUSDC, stablecoin: 'USDC', status: 'confirmed' }, 'success');
              return true;
            }
          }
        }
      }
    } catch (innerErr) {
      logger.error('Error parsing innerInstructions', innerErr?.message || innerErr);
    }

  // As a last resort log the full tx for debugging (will appear in logs/app.log)
  logger.info('verifyUSDCTransfer failed - full tx dump', { tx });

  return false;

    // (no further fallback)
  } catch (err) {
    logger.error('❌ Error verifying payment', err.message);
    await logToDB('payment', { txId, error: err.message }, 'failed');
    return false;
  }
}

// === Middlewares ===
app.use(bodyParser.json());
app.use(express.static('dist'));

// === Simulate Transaction ===
app.post('/rpc/simulateTransaction', async (req, res) => {
  try {
    const { message, signatures } = req.body;
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // Prepare the request for Solana RPC
    const rpcBody = {
      method: 'simulateTransaction',
      jsonrpc: '2.0',
      id: 1,
      params: [message, { sigVerify: false, replaceRecentBlockhash: true }]
    };

    const rpcResp = await axios.post(SOLANA_RPC_URL, rpcBody, {
      headers: { 'Content-Type': 'application/json', ...(buildRpcHeaders() || {}) }
    });
    if (rpcResp.data.error) {
      return res.status(400).json({ error: rpcResp.data.error });
    }
    return res.json(rpcResp.data.result);
  } catch (err) {
    logger.error('❌ simulateTransaction', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// === Routes ===
app.get('/', async (req, res) => {
  await logToDB('home_access', { ip: req.ip });
  res.sendFile('index.html', { root: 'dist' });
});

// Simple proxy route for RPC calls from the browser (avoids CORS / provider restrictions)
// health check for proxy debugging
app.get('/rpc/ping', (req, res) => {
  logger.info('/rpc/ping');
  res.json({ ok: true, ts: Date.now() });
});

app.post('/rpc/getAccountInfo', async (req, res) => {
  try {
    const { pubkey } = req.body;
    logger.info('/rpc/getAccountInfo called', { body: req.body });
    if (!pubkey) return res.status(400).json({ error: 'pubkey required' });

    const pk = new PublicKey(pubkey);
    const info = await connection.getAccountInfo(pk);
    if (!info) {
      return res.json({ exists: false, account: null });
    }

    // normalize account info for JSON transport
    const accountJson = {
      exists: true,
      lamports: info.lamports,
      owner: info.owner?.toString?.() || null,
      executable: !!info.executable,
      data: info.data ? Buffer.from(info.data).toString('base64') : null,
    };
    return res.json(accountJson);
  } catch (err) {
    logger.error('❌ rpc/getAccountInfo', { message: err.message, stack: err.stack });
    await logToDB('rpc_getAccountInfo', { error: err.message, stack: err.stack, body: req.body }, 'error');
    // Map some common errors to 403/500 as-is
    if (err?.message && err.message.includes('403')) {
      return res.status(403).json({ error: 'Access forbidden to RPC provider', details: err.message });
    }
    const resp = { error: err.message || 'unknown' };
    if (process.env.NODE_ENV !== 'production') resp.stack = err.stack;
    return res.status(500).json(resp);
  }
});

// Get latest blockhash (no sensitive info, can be public)
app.get('/rpc/getLatestBlockhash', async (req, res) => {
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    res.json({ blockhash });
  } catch (err) {
    logger.error('❌ getLatestBlockhash', err);
    res.status(500).json({ error: err.message });
  }
});

// === /prompt ===
app.post('/prompt', async (req, res) => {
  const { objectif, details, txId, senderAddress } = req.body;

  await logToDB('prompt_request', { objectif, details, txId, senderAddress });

  if (!txId || !senderAddress) {
    return res.status(402).json({
      message: 'txId and senderAddress required',
      amount: '0.001',
      receiver: X402_RECEIVER_ADDRESS
    });
  }

  // Conformément à la spec x402, préfère interroger un facilitateur /verify si disponible.
  // Sinon effectue une seule vérification on-chain (verifyUSDCTransfer) sans boucle.
  let paid = false;

  // use configured facilitator url or default PayAI facilitator
  if (FACILITATOR_URL) {
    const base = FACILITATOR_URL.replace(/\/$/, '');
    const verifyUrl = base.endsWith('/verify') ? base : `${base}/verify`;
    try {
      logger.info('🧾 Calling facilitator /verify', { url: verifyUrl, txId, senderAddress });
      const resp = await axios.post(verifyUrl, { txId, sender: senderAddress }, { headers: { 'Authorization': process.env.X402_FACILITATOR_API_KEY ? `Bearer ${process.env.X402_FACILITATOR_API_KEY}` : undefined } });
      if (resp?.data && resp.data.valid) {
        paid = true;
      } else {
        logger.info('Facilitator returned not valid', { data: resp?.data });
        paid = false;
      }
    } catch (err) {
      logger.warn('Error calling facilitator /verify, falling back to on-chain single check', { err: err?.message || err });
      // fallback to on-chain check below
    }
  }

  if (!paid) {
    // either facilitator not configured or returned invalid or errored -> run a single on-chain verification
    const v = await verifyUSDCTransfer(txId, senderAddress);
    if (v === true) paid = true;
    // if v is false or null, consider payment not confirmed; do not loop here
  }

  if (!paid) {
    return res.status(402).json({
      message: 'Payment invalid or not confirmed',
      amount: '0.001',
      receiver: X402_RECEIVER_ADDRESS
    });
  }

  try {
    logger.info('🤖 Call IA', { objectif, details });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a creative prompt for IA specialized. Create the perfect prompt to realize this goal, using the joined details. Reply only with the optimized prompt.' },
        { role: 'user', content: `Goal: ${objectif}\nDetails: ${details}` }
      ],
      temperature: 0.6,
      max_tokens: 1500
    });

    const refinedPrompt = completion.choices[0].message.content.trim();
    await logToDB('openai_call', { input: { objectif, details }, output: refinedPrompt });
    logger.info('✅ Prompt raffiné');
    res.json({ refinedPrompt });
  } catch (err) {
    // Detect OpenAI auth/scope errors and log a clear message to help debugging
    const msg = err?.message || '';
    const status = err?.status || err?.response?.status || null;
    if (status === 401 || /Missing scopes|insufficient permissions|model.request/i.test(msg)) {
      logger.error('❌ OpenAI key missing scopes or insufficient permissions', { status, message: msg });
      await logToDB('openai_call', { error: 'openai_insufficient_scopes', message: msg, status }, 'error');
  return res.status(500).json({ error: 'AI error: OpenAI key invalid or missing scopes (check OPENAI_API_KEY and permissions).' });
    }

    logger.error('❌ OpenAI', { error: msg, stack: err.stack });
    await logToDB('openai_call', { error: msg, stack: err.stack }, 'error');
    res.status(500).json({ error: 'Erreur IA: ' + msg });
  }
});

// === Démarrage ===
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 X402 server ready: http://localhost:${PORT} | Network: ${SOLANA_NETWORK}`);
});