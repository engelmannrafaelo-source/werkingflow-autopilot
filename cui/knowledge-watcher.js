// File Watcher for Business Folder
// Created: 2026-02-19
import chokidar from 'chokidar';
export class KnowledgeWatcher {
    config;
    watcher = null;
    changeQueue = [];
    processingTimer = null;
    constructor(config) {
        this.config = config;
    }
    start() {
        console.log(`[KnowledgeWatcher] Starting watcher on ${this.config.base_path}`);
        this.watcher = chokidar.watch(this.config.base_path, {
            ignored: this.config.ignore_patterns,
            persistent: true,
            ignoreInitial: true, // Don't trigger on startup
            awaitWriteFinish: {
                stabilityThreshold: 1000, // Wait 1s for file to stabilize
                pollInterval: 100,
            },
        });
        this.watcher
            .on('add', (path) => this.handleEvent('add', path))
            .on('change', (path) => this.handleEvent('change', path))
            .on('unlink', (path) => this.handleEvent('unlink', path))
            .on('error', (error) => console.error('[KnowledgeWatcher] Error:', error));
        console.log('[KnowledgeWatcher] Monitoring started');
    }
    async handleEvent(type, filePath) {
        // Only process .md and .txt files
        if (!['.md', '.txt'].includes(filePath.slice(filePath.lastIndexOf('.')))) {
            return;
        }
        const relativePath = filePath.replace(this.config.base_path + '/', '');
        console.log(`[KnowledgeWatcher] File ${type}: ${relativePath}`);
        const event = {
            event_type: type,
            file_path: filePath,
            relative_path: relativePath,
            timestamp: new Date().toISOString(),
        };
        if (type !== 'unlink') {
            try {
                const fs = await import('fs/promises');
                const stats = await fs.stat(filePath);
                event.file_stats = {
                    size_bytes: stats.size,
                    mtime: stats.mtime.toISOString(),
                };
            }
            catch (err) {
                console.warn(`[KnowledgeWatcher] Failed to stat ${relativePath}:`, err);
            }
        }
        this.changeQueue.push(event);
        // Debounced processing
        if (this.processingTimer) {
            clearTimeout(this.processingTimer);
        }
        this.processingTimer = setTimeout(() => {
            this.processChangeQueue();
        }, this.config.debounce_ms);
    }
    async processChangeQueue() {
        if (this.changeQueue.length === 0)
            return;
        console.log(`[KnowledgeWatcher] Processing ${this.changeQueue.length} changes`);
        // If threshold exceeded, trigger incremental scan
        if (this.changeQueue.length >= this.config.auto_scan_threshold) {
            await this.triggerIncrementalScan(this.changeQueue);
        }
        this.changeQueue = [];
    }
    async triggerIncrementalScan(changes) {
        console.log('[KnowledgeWatcher] Auto-triggering incremental scan');
        const files = changes
            .filter((c) => c.event_type !== 'unlink')
            .map((c) => c.relative_path);
        if (files.length === 0)
            return;
        try {
            // Call scanner API
            const response = await fetch('http://localhost:4005/api/team/knowledge/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'incremental',
                    files,
                    auto_assign: true,
                }),
            });
            if (!response.ok) {
                console.error('[KnowledgeWatcher] Scan failed:', await response.text());
            }
            else {
                const result = await response.json();
                console.log(`[KnowledgeWatcher] Scan complete: ${result.classified_count} classified, ${result.auto_assigned_count} assigned`);
            }
        }
        catch (err) {
            console.error('[KnowledgeWatcher] Failed to trigger scan:', err.message);
        }
    }
    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            console.log('[KnowledgeWatcher] Stopped');
        }
        if (this.processingTimer) {
            clearTimeout(this.processingTimer);
        }
    }
}
