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
  createAssociatedTokenAccountIdempotentInstruction,
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
const historySection = document.getElementById('history');
const historyList = document.getElementById('historyList');

let wallet = null;
let provider = null;

// === Load purchase history ===
async function loadHistory() {
  if (!wallet) return;
  
  try {
    const res = await fetch(`/history/${wallet}`);
    if (!res.ok) {
      console.warn('Failed to load history');
      return;
    }
    
    const purchases = await res.json();
    if (!purchases || purchases.length === 0) {
      historySection.style.display = 'none';
      return;
    }
    
    historySection.style.display = 'block';
    historyList.innerHTML = purchases.map((p, idx) => {
      const date = new Date(p.timestamp).toLocaleString();
      const isSuccess = p.status === 'success';
      const statusClass = isSuccess ? 'success' : 'failed';
      const statusIcon = isSuccess ? '✅' : '❌';
      const accordionId = `accordion-${idx}`;
      const itemId = `item-${idx}`;
      
      if (isSuccess) {
        return `
          <div class="history-item ${statusClass}" data-accordion="${accordionId}" id="${itemId}">
            <div class="history-header">
              <div class="date">${statusIcon} ${date}</div>
              <strong>Time:</strong> ${escapeHtml(p.objectif)} min
            </div>
            <div class="accordion-content" id="${accordionId}">
              <strong>Context:</strong> ${escapeHtml(p.details)}
              <div class="prompt-container">
                <button class="copy-prompt-btn" data-prompt="${idx}">📋 Copy</button>
                <div class="prompt" id="prompt-${idx}">${escapeHtml(p.refined_prompt)}</div>
              </div>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="history-item ${statusClass}">
            <div class="date">${statusIcon} ${date}</div>
            <strong>Time:</strong> ${escapeHtml(p.objectif)} min<br>
            <small style="color: #dc3545;">${escapeHtml(p.error_message || 'Payment failed')}</small>
          </div>
        `;
      }
    }).join('');
    
    // Attach event listeners after DOM update
    document.querySelectorAll('.history-item.success').forEach(item => {
      const accordionId = item.getAttribute('data-accordion');
      item.addEventListener('click', (e) => {
        if (!e.target.classList.contains('copy-prompt-btn')) {
          document.getElementById(accordionId).classList.toggle('open');
        }
      });
    });
    
    document.querySelectorAll('.copy-prompt-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const promptIdx = btn.getAttribute('data-prompt');
        const promptText = document.getElementById(`prompt-${promptIdx}`).textContent;
        copyPrompt(promptText, btn);
      });
    });
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

// Helper to escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Copy prompt from history
function copyPrompt(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Failed to copy');
  });
}

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
  resultDiv.style.display = 'none';
  
  // Hide history
  historySection.style.display = 'none';
  historyList.innerHTML = '';
}

// === Fonction de connexion Phantom ===
async function connectPhantom() {
  if (!window.solana?.isPhantom) {
    walletStatus.innerHTML = 'Phantom not detected. <a href="https://phantom.app" target="_blank">Install</a>';
    return;
  }

  try {
    provider = window.solana;
    await provider.connect({
      onlyIfTrusted: false
    });
    wallet = provider.publicKey.toString();
    walletStatus.innerHTML = `<code>${wallet.slice(0, 6)}...${wallet.slice(-4)}</code> connected · <a href="#" id="disconnectWalletLink">Disconnect</a>`;
    connectBtn.style.display = 'none';
    promptForm.style.display = 'block';

    // Load purchase history when wallet connects
    loadHistory();

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
    return;
  }

  // Attente de Phantom
  const checkInterval = setInterval(() => {
    if (window.solana?.isPhantom) {
      clearInterval(checkInterval);
      connectBtn.disabled = false;
      connectBtn.textContent = '🔗 Connect Phantom';
      connectBtn.onclick = connectPhantom;
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
  if (!wallet) return alert('Connect your wallet');

  submitBtn.disabled = true;
  submitBtn.textContent = '⏳ Payment in progress...';
  resultDiv.style.display = 'none';
  const timeAvailable = document.getElementById('timeAvailable').value.trim();

  try {
  const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const receiver = new PublicKey('3LrVwGYoqUgvwUadaCrkpqBNqkgVcWpac7CYM99KbQHk');
    
    // USDC has 6 decimals, so 0.001 USDC = 1000 lamports
    const amountUSDC = 0.001;  // montant en USDC
    const amount = amountUSDC * 1_000_000; // conversion en unités natives (1 USDC = 1_000_000 unités)

    // Get addresses - use SYNC function to avoid any RPC call
    const senderATA = getAssociatedTokenAddressSync(usdcMint, provider.publicKey);
    const receiverATA = getAssociatedTokenAddressSync(usdcMint, receiver);

    // Get latest blockhash first (needed for simulation)
    let blockhash, latestBlockhash;
    try {
      const blockHashResponse = await fetch('/rpc/getLatestBlockhash');
      if (!blockHashResponse.ok) {
        const errorText = await blockHashResponse.text();
        throw new Error('Failed to get latest blockhash: ' + errorText);
      }
      const response = await blockHashResponse.json();
      blockhash = response.blockhash;
      latestBlockhash = response.latestBlockhash;
    } catch (fetchError) {
      console.error('Error fetching blockhash:', fetchError);
      throw fetchError;
    }

    // Build transaction
    const transaction = new Transaction();
    transaction.recentBlockhash = blockhash || latestBlockhash;
    transaction.feePayer = provider.publicKey;

    // Idempotent ATA creation: avoids any preflight RPC and succeeds even if ATA already exists
    transaction.add(createAssociatedTokenAccountIdempotentInstruction(provider.publicKey, receiverATA, receiver, usdcMint));
    transaction.add(createTransferInstruction(senderATA, receiverATA, provider.publicKey, amount));

    // Simulate the transaction first
    try {
      const txBytes = transaction.serialize({ requireAllSignatures: false });
      const txBase64 = Buffer.from(txBytes).toString('base64');
      const simulationResponse = await fetch('/rpc/simulateTransaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx: txBase64,
        }),
      });

      if (!simulationResponse.ok) {
        const errorData = await simulationResponse.text();
        console.error('Simulation failed:', errorData);
        throw new Error(`Transaction simulation failed: ${simulationResponse.statusText}`);
      }

      const simResult = await simulationResponse.json();
      if (simResult.error) {
        console.error('Simulation error:', simResult.error);
        throw new Error(`Transaction simulation error: ${simResult.error.message || 'Unknown error'}`);
      }
    } catch (simError) {
      console.error('Simulation error:', simError);
      const msg = simError?.message || '';
      if (/could not find account|AccountNotFound|invalid account data|owner does not match|insufficient funds/i.test(msg)) {
        throw new Error(
          "You don't have a USDC associated token account or insufficient USDC. To create one:\n" +
          "1. Swap SOL to USDC on a DEX (e.g. Jupiter: https://jup.ag)\n" +
          "2. Or deposit USDC from an exchange.\n" +
          "Your ATA will be created automatically when you receive USDC."
        );
      }
      throw new Error(`Failed to simulate transaction: ${msg}`);
    }

    const { signature } = await provider.signAndSendTransaction(transaction);
    submitBtn.textContent = '🔎 Verifying payment...';

    // Wait a few seconds for transaction to be indexed before backend verification
    await new Promise(resolve => setTimeout(resolve, 3000));

    const res = await fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        objectif: timeAvailable, 
        details: '', 
        txId: signature, 
        senderAddress: wallet,
        amount: amountUSDC
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
      resultDiv.innerHTML = `<button id="copyBtn">📋 Copy</button>${data.refinedPrompt}`;
      
      // Add copy functionality
      document.getElementById('copyBtn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(data.refinedPrompt);
          const btn = document.getElementById('copyBtn');
          btn.textContent = '✅ Copied!';
          setTimeout(() => btn.textContent = '📋 Copy', 2000);
        } catch (err) {
          console.error('Failed to copy:', err);
          alert('Failed to copy to clipboard');
        }
      });

      // Load purchase history after successful purchase
      loadHistory();
    } else {
      resultDiv.className = 'error';
      resultDiv.innerHTML = `<strong>Failed</strong><br>${data.message || 'Invalid'}`;
    }

  } catch (err) {
    console.error('Error:', err);
    resultDiv.style.display = 'block';
    resultDiv.className = 'error';
    resultDiv.textContent = 'Error: ' + (err.message || 'Unknown');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '✨ Get an idea for 0.001 $USDC';
  }
});

// === Démarrage ===
initPhantom();

// === Donation info (populated from Vite env VITE_DONATION_ADDRESS) ===
const donationEl = document.getElementById('donationInfo');
const donationAddress = import.meta.env.VITE_DONATION_ADDRESS || '';
if (donationEl) {
  if (donationAddress) {
    donationEl.innerHTML = `You can send SOL or any token to <code><u>${donationAddress}</u></code> to help me test ideas with <a href="https://x402.gitbook.io/x402">x402 protocol</a>`;
  }
}