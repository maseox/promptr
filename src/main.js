// src/main.js

// === POLYFILL BUFFER ===
import './buffer-polyfill.js';

// === Imports Solana ===

import { 
  PublicKey, 
  Transaction 
} from '@solana/web3.js';
import bs58 from './bs58.js';

import { 
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';

// Fonction pour calculer l'ATA de manière complètement offline (pas d'appel RPC)
function getAssociatedTokenAddressSync(mint, owner) {
  const seeds = [
    owner.toBytes(),
    TOKEN_PROGRAM_ID.toBytes(),
    mint.toBytes(),
  ];
  
  // Dérivation de clé manuelle sans appel RPC
  const [address] = PublicKey.findProgramAddressSync(
    seeds,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

// === Éléments DOM ===
const resultDiv = document.getElementById('result');
const submitBtn = document.getElementById('submitBtn');
const connectBtn = document.getElementById('connectWallet');
const walletStatus = document.getElementById('walletStatus');
const promptForm = document.getElementById('promptForm');

let wallet = null;
let provider = null;

// === Disconnect Phantom ===
async function disconnectPhantom() {
  try {
    if (provider && provider.disconnect) {
      await provider.disconnect();
    } else if (window.solana && window.solana.disconnect) {
      // fallback
      await window.solana.disconnect();
    }
  } catch (err) {
    console.warn('Error during disconnect:', err);
  }

  // Reset UI state
  wallet = null;
  provider = null;
  walletStatus.innerHTML = '';
  connectBtn.style.display = '';
  connectBtn.disabled = false;
  connectBtn.textContent = '🔗 Connect Phantom';
  connectBtn.onclick = connectPhantom;
  promptForm.style.display = 'none';
}

// === Fonction de connexion Phantom ===
async function connectPhantom() {
  if (!window.solana?.isPhantom) {
    walletStatus.innerHTML = 'Phantom not detected. <a href="https://phantom.app" target="_blank">Install</a>';
    return;
  }

  try {
    provider = window.solana;
    await provider.connect();
    wallet = provider.publicKey.toString();
    walletStatus.innerHTML = `<code>${wallet.slice(0, 6)}...${wallet.slice(-4)}</code> connected · <a href="#" id="disconnectWalletLink">Disconnect</a>`;
    connectBtn.style.display = 'none';
    promptForm.style.display = 'block';

    // Wire the disconnect link we just added
    const disconnectLink = document.getElementById('disconnectWalletLink');
    if (disconnectLink) {
      disconnectLink.onclick = async (ev) => {
        ev.preventDefault();
        await disconnectPhantom();
      };
    }
  } catch (err) {
    walletStatus.textContent = 'Connection refused';
    console.error('Connection error:', err);
  }
}

// === Initialisation : Phantom prêt ? ===
function initPhantom() {
  // Phantom déjà présent ?
  if (window.solana?.isPhantom) {
    connectBtn.disabled = false;
    connectBtn.textContent = '🔗 Connect Phantom';
    connectBtn.onclick = connectPhantom;
    console.log('Phantom prêt');
    return;
  }

  // Attente de Phantom
  const checkInterval = setInterval(() => {
    if (window.solana?.isPhantom) {
      clearInterval(checkInterval);
      connectBtn.disabled = false;
      connectBtn.textContent = '🔗 Connect Phantom';
      connectBtn.onclick = connectPhantom;
      console.log('Phantom detected');
    }
  }, 300);

  // Timeout 10s
  setTimeout(() => {
    if (!window.solana?.isPhantom) {
      clearInterval(checkInterval);
      connectBtn.disabled = false;
      connectBtn.textContent = 'Phantom not found';
      walletStatus.innerHTML = 'Phantom not detected. <a href="https://phantom.app" target="_blank">Install</a>';
    }
  }, 10000);
}

// === Payment & Refinement ===
promptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet) return alert('Connectez votre wallet');

  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Payment in progress...';
  resultDiv.style.display = 'none';
  const objectif = document.getElementById('objectif').value.trim();
  const details = document.getElementById('details').value.trim();

  try {
  const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const receiver = new PublicKey('3LrVwGYoqUgvwUadaCrkpqBNqkgVcWpac7CYM99KbQHk');
    
    // USDC has 6 decimals, so 0.001 USDC = 1000 lamports
    const amountUSDC = 0.001;  // montant en USDC
    const amount = amountUSDC * 1_000_000; // conversion en unités natives (1 USDC = 1_000_000 unités)

    // Get addresses - use SYNC function to avoid any RPC call
    const senderATA = getAssociatedTokenAddressSync(usdcMint, provider.publicKey);
    const receiverATA = getAssociatedTokenAddressSync(usdcMint, receiver);

  // Check sender has a USDC account
  console.log('Checking USDC account...');
  console.log('Wallet address:', provider.publicKey.toString());
  console.log('Sender USDC account (ATA):', senderATA.toString());
    
    const senderATAInfo = await fetch('/rpc/getAccountInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: senderATA.toString() })
    });

    if (!senderATAInfo.ok) {
      console.error('RPC error:', await senderATAInfo.text());
      throw new Error('Error checking USDC account. See console for details.');
    }

    const accountData = await senderATAInfo.json();
    console.log('RPC response:', accountData);

    if (!accountData.exists) {
      console.log('USDC account not found. Response details:', accountData);
      throw new Error(
        "You don't have a USDC associated token account. To create one:\n" +
        "1. Swap SOL to USDC on a DEX (e.g. Jupiter: https://jup.ag)\n" +
        "2. Or deposit USDC from an exchange to your wallet.\n" +
        "Your ATA will be created automatically when you receive USDC."
      );
    }

    console.log('USDC account found!');

    // Get latest blockhash first (needed for simulation)
    const blockHashResponse = await fetch('/rpc/getLatestBlockhash');
    if (!blockHashResponse.ok) {
      throw new Error('Failed to get latest blockhash');
    }
    const { latestBlockhash } = await blockHashResponse.json();

    // Build transaction
    const transaction = new Transaction();
    transaction.recentBlockhash = latestBlockhash;
    transaction.feePayer = provider.publicKey;

    // ask backend whether the receiver associated token account exists (avoid browser RPC 403)
    // Use a relative path so Vite's proxy (dev) forwards to the backend and production (same origin) works too
    const checkResp = await fetch('/rpc/getAccountInfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: receiverATA.toString() })
    });

    if (!checkResp.ok) {
      const errText = await checkResp.text().catch(() => null);
      throw new Error(errText || `RPC check failed (${checkResp.status})`);
    }

    const checkData = await checkResp.json();
    if (!checkData.exists) {
      transaction.add(createAssociatedTokenAccountInstruction(provider.publicKey, receiverATA, receiver, usdcMint));
    }

    // Get latest blockhash from backend
    const bhResp = await fetch('/rpc/getLatestBlockhash');
    if (!bhResp.ok) {
      throw new Error('Failed to get latest blockhash');
    }
    const { blockhash } = await bhResp.json();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = provider.publicKey;

    transaction.add(createTransferInstruction(senderATA, receiverATA, provider.publicKey, amount));


    // Simulate the transaction first
    try {

      const txBytes = transaction.serialize({ requireAllSignatures: false });
      const txBase58 = bs58.encode(txBytes);
      const simulationResponse = await fetch('/rpc/simulateTransaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: txBase58,
          signatures: [
            {
              signature: null,
              publicKey: provider.publicKey.toBase58(),
            },
          ],
        }),
      });

      if (!simulationResponse.ok) {
        const errorData = await simulationResponse.text();
        console.error('Simulation response:', errorData);
        throw new Error(`Transaction simulation failed: ${simulationResponse.statusText}`);
      }

      const simResult = await simulationResponse.json();
      if (simResult.error) {
        console.error('Simulation error:', simResult.error);
        throw new Error(`Transaction simulation error: ${simResult.error.message || 'Unknown error'}`);
      }

      console.log('Transaction simulation successful');
    } catch (simError) {
      console.error('Simulation error:', simError);
      throw new Error(`Failed to simulate transaction: ${simError.message}`);
    }

    const { signature } = await provider.signAndSendTransaction(transaction);
  // don't call RPC confirm from the browser (may hit provider restrictions)
  // the backend `/prompt` will verify the transaction server-side using a trusted RPC connection
    // Update UI to indicate we're checking confirmations
  submitBtn.textContent = '🔎 Verifying payment...';

    const res = await fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        objectif, 
        details, 
        txId: signature, 
        senderAddress: wallet,
        amount: amountUSDC  // on envoie le montant pour vérification
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server error: ${res.status} ${errText || 'No details'}`);
    }

    const data = await res.json();
    resultDiv.style.display = 'block';

    if (res.ok) {
      resultDiv.className = 'success';
      resultDiv.textContent = data.refinedPrompt;
    } else {
      resultDiv.className = 'error';
      resultDiv.innerHTML = `<strong>Failure</strong><br>${data.message || 'Invalid'}`;
    }

  } catch (err) {
    console.error('Error:', err);
    resultDiv.style.display = 'block';
    resultDiv.className = 'error';
    resultDiv.textContent = 'Error: ' + (err.message || 'Unknown');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '🚀 Refine';
  }
});

// === Démarrage ===
initPhantom();

// === Donation info (populated from Vite env VITE_DONATION_ADDRESS) ===
const donationEl = document.getElementById('donationInfo');
const donationAddress = import.meta.env.VITE_DONATION_ADDRESS || '';
if (donationEl) {
  if (donationAddress) {
    donationEl.innerHTML = `Donations: you can send SOL or tokens to <code>${donationAddress}</code> to help me test crazy ideas with <a href="https://x402.gitbook.io/x402">x402 protocol</a>`;
  } 
}