const express = require('express');
const path = require('path');
const { runTests } = require('./test-runner');

const app = express();
const PORT = process.env.PORT || 3847;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// SSE endpoint for real-time test results
app.post('/api/run-tests', async (req, res) => {
  const { stores, tests } = req.body;

  if (!stores || !stores.length) {
    return res.status(400).json({ error: 'No stores provided' });
  }
  if (!tests || !tests.length) {
    return res.status(400).json({ error: 'No tests selected' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runTests(stores, tests, sendEvent);
    sendEvent({ type: 'complete' });
  } catch (err) {
    sendEvent({ type: 'error', message: err.message });
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`QA Automation running at http://localhost:${PORT}`);
});
