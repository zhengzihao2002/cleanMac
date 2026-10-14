'use strict';

// Runs every *.test.js file in this folder with Node's built-in test runner.
// Works with plain Node and with the Node.js built into cleanMac.app.

const fs = require('fs');
const path = require('path');

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith('.test.js')) require(path.join(__dirname, file));
}
