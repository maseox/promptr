require('dotenv').config();
const { OpenAI } = require('openai');

console.log('Testing OpenAI key...');
console.log('Key (obfuscated):', process.env.OPENAI_API_KEY?.slice(0, 10) + '...' + process.env.OPENAI_API_KEY?.slice(-10));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  try {
    console.log('\nSending test request to OpenAI...');
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Say "API key is working!"' },
        { role: 'user', content: 'Test' }
      ],
      max_tokens: 10
    });
    
    console.log('✅ SUCCESS! API key is valid.');
    console.log('Response:', response.choices[0].message.content);
    process.exit(0);
  } catch (err) {
    console.error('❌ ERROR! API key test failed.');
    console.error('Status:', err.status || err?.response?.status || 'N/A');
    console.error('Message:', err.message);
    if (err?.response?.data) {
      console.error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
})();
