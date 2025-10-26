import { Buffer } from 'buffer';

// Ensure all Buffer methods are available
if (typeof window !== 'undefined') {
  window.Buffer = Buffer;
  window.Buffer.from = Buffer.from;
  window.Buffer.alloc = Buffer.alloc;
  window.Buffer.allocUnsafe = Buffer.allocUnsafe;
  window.Buffer.isBuffer = Buffer.isBuffer;
}

if (typeof global !== 'undefined') {
  global.Buffer = Buffer;
}

export { Buffer };