# CUI Virtual Office - Complete API Reference

**Base URL**: `http://localhost:4005`

Alle Endpoints können sowohl von der UI als auch programmatisch (inkl. von Rafbot) genutzt werden.

---

## 🎯 Command API (High-Level Control)

### POST `/api/commands/run-agent`
**Trigger any agent with optional test mode**

```bash
curl -X POST http://localhost:4005/api/commands/run-agent \
  -H 'Content-Type: application/json' \
  -d '{
    "persona_id": "rafbot",
    "task": "Check system health",
    "test_mode": false
  }'
```

**Parameters**:
- `persona_id` (required): Agent ID (e.g., "rafbot", "max-weber", "herbert-sicher")
- `task` (optional): Custom task description
- `test_mode` (optional, boolean): If true, instructs agent to generate dummy test data

**Response**:
```json
{
  "success": true,
  "message": "Agent rafbot started",
  "pid": 12345
}
```

---

### POST `/api/commands/trigger-rafbot-test`
**Special: Run Rafbot in full test mode**

Triggers Rafbot to fill the system with test data (approvals, inbox messages, reports).

```bash
curl -X POST http://localhost:4005/api/commands/trigger-rafbot-test
```

**Response**: Same as `/run-agent`

---

### POST `/api/commands/approve-all`
**Bulk approve all pending business changes**

```bash
curl -X POST http://localhost:4005/api/commands/approve-all
```

**Response**:
```json
{
  "success": true,
  "approved_count": 3,
  "files": [
    "/root/projekte/werkingflow/business/reports/rafbot/2026-02-22-status.md",
    "..."
  ]
}
```

---

### GET `/api/commands/status`
**Get complete system status**

```bash
curl http://localhost:4005/api/commands/status | jq
```

**Response**:
```json
{
  "agents": {
    "total": 16,
    "working": 2,
    "idle": 14
  },
  "approvals": {
    "pending": 5
  },
  "inbox": {
    "total_messages": 12
  },
  "timestamp": "2026-02-24T10:41:41.965Z"
}
```

---

## 👤 Agent API

### GET `/api/agents/claude/status`
**List all agents with their current status**

```bash
curl http://localhost:4005/api/agents/claude/status | jq
```

**Response**:
```json
{
  "agents": [
    {
      "id": "rafbot",
      "persona_id": "rafbot",
      "persona_name": "Rafbot",
      "schedule": "on-demand",
      "status": "idle",
      "last_run": "2026-02-24T06:40:00.000Z",
      "last_actions": 5,
      "inbox_count": 0,
      "approvals_count": 0
    }
  ]
}
```

---

### GET `/api/agents/persona/:id`
**Get individual persona metadata**

```bash
curl http://localhost:4005/api/agents/persona/rafbot | jq
```

**Response**:
```json
{
  "id": "rafbot",
  "name": "Rafbot",
  "role": "Virtual Office Manager",
  "mbti": "ISTJ \"The Inspector\"",
  "team": "Management",
  "motto": "I gather all the information, you make the decisions."
}
```

---

### POST `/api/agents/claude/run`
**Run an agent (low-level)**

```bash
curl -X POST http://localhost:4005/api/agents/claude/run \
  -H 'Content-Type: application/json' \
  -d '{
    "persona_id": "herbert-sicher",
    "mode": "plan"
  }'
```

**Prefer** `/api/commands/run-agent` for better control.

---

### GET `/api/agents/claude/memory/:id`
**Get agent's memory/history**

```bash
curl http://localhost:4005/api/agents/claude/memory/rafbot | jq
```

**Response**:
```json
{
  "memory": [
    {
      "timestamp": "2026-02-22T06:40:15.123Z",
      "trigger": "scheduled",
      "actions": 3,
      "action_types": ["read", "write", "approve"]
    }
  ]
}
```

---

## 📬 Inbox API

### GET `/api/agents/inbox/:id`
**Get agent's inbox messages**

```bash
curl http://localhost:4005/api/agents/inbox/birgit-bauer | jq
```

**Response**:
```json
{
  "messages": [
    {
      "from": "Kai Hoffmann",
      "subject": "Automation Update",
      "timestamp": "2026-02-10T14:30:00.000Z",
      "content": "# Automation Progress\n\n..."
    }
  ]
}
```

---

## 📋 Business Approval API

### GET `/api/agents/business/pending`
**List all pending approvals**

```bash
curl http://localhost:4005/api/agents/business/pending | jq
```

**Response**:
```json
{
  "pending": [
    {
      "index": 0,
      "timestamp": "2026-02-22T06:40:15.123Z",
      "persona": "rafbot",
      "file": "business/reports/rafbot/2026-02-22-0640-office-status.md.pending",
      "summary": "Erster Rafbot META-Zyklus: 3 Infrastruktur-Issues behoben"
    }
  ]
}
```

---

### GET `/api/agents/business/diff/:file`
**Get diff for a pending file**

```bash
curl 'http://localhost:4005/api/agents/business/diff/reports/rafbot/2026-02-22-0640-office-status.md.pending' | jq
```

**Note**: Path should be **relative to business/** directory (no `business/` prefix!)

**Response**:
```json
{
  "pending": "# New content...",
  "final": "# Old content..."
}
```

---

### POST `/api/agents/business/approve`
**Approve a pending change**

```bash
curl -X POST http://localhost:4005/api/agents/business/approve \
  -H 'Content-Type: application/json' \
  -d '{
    "index": 0,
    "commit_message": "Approved: Rafbot office status report"
  }'
```

**Parameters**:
- `index` (required): Index from `/pending` response
- `commit_message` (optional): Custom commit message

**Response**:
```json
{
  "success": true,
  "file": "business/reports/rafbot/2026-02-22-0640-office-status.md"
}
```

---

### POST `/api/agents/business/reject`
**Reject a pending change**

```bash
curl -X POST http://localhost:4005/api/agents/business/reject \
  -H 'Content-Type: application/json' \
  -d '{"index": 0}'
```

---

## 📚 Knowledge Base API

### GET `/api/team/knowledge/persona/:id`
**Get agent's assigned knowledge documents**

```bash
curl 'http://localhost:4005/api/team/knowledge/persona/rafbot' | jq
```

**Response**:
```json
{
  "persona": {
    "persona_id": "rafbot",
    "primary_documents": [
      "shared/VISION.md",
      "README.md"
    ],
    "secondary_documents": [],
    "total_document_count": 14
  },
  "documents": {
    "primary": [
      {
        "path": "shared/VISION.md",
        "filename": "VISION.md",
        "category": "shared",
        "content_summary": "CEO Vision Document...",
        "topics": ["product-vision", "marketplace"]
      }
    ],
    "secondary": []
  }
}
```

---

### GET `/api/business/document?path=...`
**Read a business document**

```bash
curl 'http://localhost:4005/api/business/document?path=/root/projekte/werkingflow/business/shared/VISION.md' | jq
```

**Response**:
```json
{
  "content": "# WerkING Tools - Die Vision\n\n..."
}
```

---

## 🔄 Activity Stream (SSE)

### GET `/api/agents/activity-stream`
**Real-time event stream**

```bash
curl -N http://localhost:4005/api/agents/activity-stream
```

**Events**:
```
data: {"type":"ping","timestamp":"2026-02-24T10:41:41.965Z"}

data: {"type":"agent-started","persona_id":"rafbot","timestamp":"..."}

data: {"type":"agent-completed","persona_id":"rafbot","actions":3}
```

---

## 📊 Team Structure API

### GET `/api/agents/team/structure`
**Get org chart + RACI matrix**

```bash
curl http://localhost:4005/api/agents/team/structure | jq
```

**Response**:
```json
{
  "orgChart": [
    {
      "id": "max-weber",
      "name": "Max Weber",
      "role": "CTO",
      "children": [
        {
          "id": "herbert-sicher",
          "name": "Herbert Sicher",
          "role": "Security Engineer",
          "children": []
        }
      ]
    }
  ],
  "raciMatrix": [
    {
      "task": "Security Audits",
      "owner": "herbert-sicher",
      "responsible": ["herbert-sicher"],
      "consulted": ["max-weber"]
    }
  ]
}
```

---

## 🎮 Example Workflows

### Run Full System Test
```bash
# 1. Trigger Rafbot test mode
curl -X POST http://localhost:4005/api/commands/trigger-rafbot-test

# 2. Wait 30 seconds
sleep 30

# 3. Check status
curl http://localhost:4005/api/commands/status | jq

# 4. Approve all
curl -X POST http://localhost:4005/api/commands/approve-all | jq
```

### Run Specific Agent
```bash
curl -X POST http://localhost:4005/api/commands/run-agent \
  -H 'Content-Type: application/json' \
  -d '{
    "persona_id": "herbert-sicher",
    "task": "Scan for security issues in latest commits"
  }'
```

### Monitor Activity
```bash
# Terminal 1: Watch activity stream
curl -N http://localhost:4005/api/agents/activity-stream

# Terminal 2: Trigger agents
curl -X POST http://localhost:4005/api/commands/run-agent -d '{"persona_id":"rafbot"}'
```

---

## 🤖 Rafbot Self-Service

Rafbot (oder jeder Agent) kann sich selbst triggern oder andere Agents starten:

```python
# In agent's Python code or via Claude Code
import requests

# Self-trigger
requests.post('http://localhost:4005/api/commands/run-agent', json={
    'persona_id': 'rafbot',
    'task': 'Daily health check'
})

# Trigger another agent
requests.post('http://localhost:4005/api/commands/run-agent', json={
    'persona_id': 'herbert-sicher',
    'task': 'Security audit requested by Rafbot'
})

# Check system status
status = requests.get('http://localhost:4005/api/commands/status').json()
if status['approvals']['pending'] > 10:
    # Notify Rafael
    pass
```

---

## 🔐 Security Note

⚠️ **Current State**: No authentication - APIs are open on localhost

**For Production**:
- Add Bearer token auth
- Rate limiting
- Audit logging

---

*Last updated: 2026-02-24*
*Server version: CUI v1.0 with full API Command System*
