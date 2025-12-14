// Global Teardown for Playwright Tests
const fs = require('fs').promises;
const path = require('path');

async function globalTeardown(config) {
  console.log('🧹 Starting Playwright Global Teardown...');
  
  try {
    // Generate test summary report
    await generateTestSummary();
    
    // Clean up any temporary files or test data
    await cleanupTestData();
    
    // Archive test results if needed
    await archiveTestResults();
    
    console.log('✅ Global teardown completed successfully');
    
  } catch (error) {
    console.error('❌ Global teardown failed:', error.message);
    // Don't throw here as it might mask test failures
  }
}

async function generateTestSummary() {
  console.log('📊 Generating test summary...');
  
  try {
    const resultsPath = path.join(process.cwd(), 'test-results', 'results.json');
    
    // Check if results file exists
    try {
      await fs.access(resultsPath);
    } catch (error) {
      console.log('ℹ️ No test results file found, skipping summary generation');
      return;
    }
    
    // Read test results
    const resultsData = await fs.readFile(resultsPath, 'utf8');
    const results = JSON.parse(resultsData);
    
    // Generate summary
    const summary = {
      timestamp: new Date().toISOString(),
      totalTests: results.suites?.reduce((total, suite) => total + (suite.specs?.length || 0), 0) || 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: results.stats?.duration || 0,
      browser_coverage: []
    };
    
    // Count test results
    if (results.suites) {
      results.suites.forEach(suite => {
        if (suite.specs) {
          suite.specs.forEach(spec => {
            if (spec.tests) {
              spec.tests.forEach(test => {
                if (test.results) {
                  test.results.forEach(result => {
                    switch (result.status) {
                      case 'passed':
                        summary.passed++;
                        break;
                      case 'failed':
                        summary.failed++;
                        break;
                      case 'skipped':
                        summary.skipped++;
                        break;
                    }
                  });
                }
              });
            }
          });
        }
      });
    }
    
    // Save summary
    const summaryPath = path.join(process.cwd(), 'test-results', 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    
    console.log('📋 Test Summary:');
    console.log(`   Total Tests: ${summary.totalTests}`);
    console.log(`   ✅ Passed: ${summary.passed}`);
    console.log(`   ❌ Failed: ${summary.failed}`);
    console.log(`   ⏭️ Skipped: ${summary.skipped}`);
    console.log(`   ⏱️ Duration: ${Math.round(summary.duration / 1000)}s`);
    
  } catch (error) {
    console.error('❌ Failed to generate test summary:', error.message);
  }
}

async function cleanupTestData() {
  console.log('🧹 Cleaning up test data...');
  
  try {
    // Clean up any temporary test files
    const tempDir = path.join(process.cwd(), 'temp-test-data');
    
    try {
      await fs.access(tempDir);
      await fs.rmdir(tempDir, { recursive: true });
      console.log('✅ Temporary test data cleaned up');
    } catch (error) {
      // Directory doesn't exist, which is fine
      console.log('ℹ️ No temporary test data to clean up');
    }
    
  } catch (error) {
    console.error('❌ Failed to clean up test data:', error.message);
  }
}

async function archiveTestResults() {
  console.log('📦 Archiving test results...');
  
  try {
    const resultsDir = path.join(process.cwd(), 'test-results');
    const archiveDir = path.join(process.cwd(), 'test-archives');
    
    // Create archive directory if it doesn't exist
    try {
      await fs.mkdir(archiveDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    // Create timestamp for archive
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `test-results-${timestamp}`;
    const archivePath = path.join(archiveDir, archiveName);
    
    // Copy results to archive (simplified - in production you might use tar/zip)
    try {
      await fs.mkdir(archivePath, { recursive: true });
      
      // Copy key files
      const filesToArchive = ['summary.json', 'results.json', 'junit.xml'];
      
      for (const file of filesToArchive) {
        const sourcePath = path.join(resultsDir, file);
        const destPath = path.join(archivePath, file);
        
        try {
          await fs.copyFile(sourcePath, destPath);
        } catch (error) {
          // File might not exist, continue
          console.log(`ℹ️ Skipping ${file} (not found)`);
        }
      }
      
      console.log(`✅ Test results archived to: ${archiveName}`);
      
    } catch (error) {
      console.log('ℹ️ Archiving skipped (no results to archive)');
    }
    
  } catch (error) {
    console.error('❌ Failed to archive test results:', error.message);
  }
}

module.exports = globalTeardown;
