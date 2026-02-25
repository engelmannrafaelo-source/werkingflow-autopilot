// Simple endpoint wrapper for start-all-panels.sh
const { spawn } = require('child_process');
const path = require('path');

module.exports = function(app, WORKSPACE_ROOT) {
  app.post('/api/start-all-panels', (req, res) => {
    console.log('[Start-Panels] Request received');
    
    const script = path.join(WORKSPACE_ROOT, 'start-all-panels.sh');
    
    // Spawn detached
    const child = spawn('bash', [script], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    
    child.unref();
    
    res.json({ 
      ok: true, 
      message: 'Starting panels in background',
      note: 'Check /tmp/*-autostart.log for progress'
    });
  });
};
