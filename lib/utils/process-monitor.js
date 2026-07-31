// lib/utils/process-monitor.js
const fs = require('fs');
const path = require('path');

class ProcessMonitor {
  constructor(logger) {
    this.logger = logger;
    this.packageInfo = this.getPackageInfo();
    this.processName = this.packageInfo.name || 'unknown-app';
  }

  getPackageInfo() {
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    } catch (e) {
      return { name: 'unknown', version: 'unknown' };
    }
  }

  logStartup(additionalInfo = {}) {
    const startupInfo = {
      msg: `${this.processName} started`,
      app_name: this.processName,
      app_version: this.packageInfo.version,
      pid: process.pid,
      ppid: process.ppid,
      pm2_instance_id: process.env.NODE_APP_INSTANCE || 'not_pm2',
      pm2_id: process.env.pm_id,
      is_pm2: !!process.env.PM2,
      node_version: process.version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      ...additionalInfo
    };

    this.logger.info(startupInfo);
    return startupInfo;
  }

  setupSignalHandlers() {
    /* Log when we receive signals that would cause restart.
       These handlers LOG ONLY. They used to call process.exit(0), and because this
       is installed before app.js registers its own SIGTERM/SIGINT handler, node ran
       this listener first and exited the process from inside it -- app.js's graceful
       shutdown (deregistering this feature server from redis, then draining
       in-progress calls) never got to run at all. Ownership of the exit belongs to
       app.js's handler, which exits as soon as the call count reaches zero. */
    process.on('SIGINT', () => {
      this.logger.info({
        msg: 'SIGINT received',
        app_name: this.processName,
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    process.on('SIGTERM', () => {
      this.logger.info({
        msg: 'SIGTERM received',
        app_name: this.processName,
        pid: process.pid,
        ppid: process.ppid,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    process.on('uncaughtException', (error) => {
      this.logger.error({
        msg: 'Uncaught exception - process will restart',
        app_name: this.processName,
        error: error.message,
        stack: error.stack,
        pid: process.pid,
        timestamp: new Date().toISOString()
      });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error({
        msg: 'Unhandled rejection',
        app_name: this.processName,
        reason,
        pid: process.pid,
        timestamp: new Date().toISOString()
      });
    });
  }
}

module.exports = ProcessMonitor;
