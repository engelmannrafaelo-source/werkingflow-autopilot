# CUI Partner Deployment

Deploy CUI Workspace to a partner server (Hetzner VPS + Tailscale VPN).

## Architecture

```
Partner Browser ──HTTPS──> Partner VPS (:4005)
                              │
                              ├── CUI Workspace Server (Express)
                              ├── Claude CLI Sessions (FIFO-based)
                              └── Tailscale VPN ──> AI Bridge (Hetzner)
```

Partners get a browser link + login credentials. Auth is enforced via JWT + users.json.

## Quick Start (New Partner Server)

### 1. Provision Server

```bash
# On fresh Ubuntu 22.04/24.04 VPS (Hetzner ~4€/month)
scp deploy/setup-partner-server.sh root@<server-ip>:/tmp/
ssh root@<server-ip> bash /tmp/setup-partner-server.sh
```

### 2. Join Tailscale Network

```bash
ssh root@<server-ip> tailscale up
# Opens browser link — authenticate with Rafael's Google account
```

### 3. Deploy CUI

```bash
# From dev-server
./deploy/deploy-to-partner.sh <tailscale-ip>
```

### 4. Configure Environment

```bash
ssh root@<tailscale-ip>
cp /opt/cui-workspace/deploy/.env.partner.example /opt/cui-workspace/.env
# Edit .env: set AI_BRIDGE_API_KEY (get from Rafael)
```

### 5. Set Up Claude Auth

```bash
ssh root@<tailscale-ip>
/opt/cui-workspace/deploy/setup-claude-auth.sh 1 "Partner"
su - claude-user
HOME=/home/claude-user/.cui-account1 claude login
# Complete OAuth in browser
```

### 6. Create Users

```bash
ssh root@<tailscale-ip>
/opt/cui-workspace/deploy/create-partner-users.sh /opt/cui-workspace/data/users.json
# Interactive: creates users with hashed passwords
```

### 7. Start

```bash
systemctl restart cui-workspace
# Access: http://<tailscale-ip>:4005
```

## Scripts

| Script | Where to Run | Purpose |
|--------|-------------|---------|
| `setup-partner-server.sh` | Partner VPS | Initial OS provisioning |
| `deploy-to-partner.sh` | Dev Server | Sync CUI code + restart |
| `setup-claude-auth.sh` | Partner VPS | Create Claude account dirs |
| `create-partner-users.sh` | Partner VPS | Interactive user creation |
| `hash-password.sh` | Anywhere | Generate SHA-256 password hash |

## User Roles

| Role | Panels | Git Push | Approve Edits |
|------|--------|----------|---------------|
| `admin` | All | Yes | Yes |
| `product-owner` | CUI, Chat, Browser, Preview, Notes, Mission, QA, Architecture | Yes | Yes |
| `fachpartner` | CUI, Chat, Browser, Preview, Notes | No | No |

## Updating

```bash
# From dev-server — rebuilds + syncs + restarts
./deploy/deploy-to-partner.sh <tailscale-ip>
```

users.json and .env are preserved during updates (excluded from rsync).

## Troubleshooting

```bash
# Check service status
ssh root@<ip> systemctl status cui-workspace

# View logs
ssh root@<ip> journalctl -u cui-workspace -n 100 -f

# Check active sessions
ssh root@<ip> ls /run/cui-sessions/

# Test auth
ssh root@<ip> curl -s localhost:4005/api/auth/status
```
