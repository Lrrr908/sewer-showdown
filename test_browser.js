// Simple Node.js script to test if the game loads
// This will use puppeteer if available, otherwise just report that manual testing is needed

const http = require('http');

// First, just test if the server is responding
const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/',
  method: 'GET'
};

console.log('Testing if http://localhost:8080 is accessible...');

const req = http.request(options, (res) => {
  console.log(`✓ Server responded with status: ${res.statusCode}`);
  console.log(`✓ Content-Type: ${res.headers['content-type']}`);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log(`✓ Received ${data.length} bytes of HTML`);
    
    // Check if the HTML contains the expected elements
    const checks = [
      { name: 'Canvas element', pattern: /<canvas id="gameCanvas">/ },
      { name: 'Game script', pattern: /<script src="js\/game\.js/ },
      { name: 'Info panel', pattern: /id="infoPanel"/ },
      { name: 'Building overlay', pattern: /id="buildingOverlay"/ }
    ];
    
    console.log('\nHTML Structure Checks:');
    checks.forEach(check => {
      if (check.pattern.test(data)) {
        console.log(`  ✓ ${check.name} found`);
      } else {
        console.log(`  ✗ ${check.name} NOT FOUND`);
      }
    });
    
    console.log('\n✓ Basic server test complete!');
    console.log('\nTo fully test the game:');
    console.log('1. Open http://localhost:8080 in your browser');
    console.log('2. Open Developer Tools (F12)');
    console.log('3. Check the Console tab for any errors');
    console.log('4. Look for messages like "COWABUNGA! World ready" and "Sprites loaded"');
    console.log('5. Try pressing arrow keys or WASD to move the Party Wagon');
  });
});

req.on('error', (e) => {
  console.error(`✗ Error connecting to server: ${e.message}`);
  console.log('\nMake sure the server is running with:');
  console.log('  cd /home/beast/tmnt-art-show && python3 -m http.server 8080');
});

req.end();
