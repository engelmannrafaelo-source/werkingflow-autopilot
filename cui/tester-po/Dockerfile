FROM mcr.microsoft.com/playwright/python:v1.58.0-jammy

WORKDIR /tester

COPY requirements.txt /tester/requirements.txt
RUN pip install --no-cache-dir -r /tester/requirements.txt

COPY run_po.py /tester/run_po.py

# Volumes (mounted at runtime):
#   /scenario   ro  — single scenario.json
#   /report     rw  — output (result.json, bridge.txt, page-text.txt, screenshot.png)
#
# Env (required at runtime):
#   AI_BRIDGE_URL       Bridge endpoint
#   AI_BRIDGE_API_KEY   Bridge auth token
#
# Network: bridge mode with --add-host host.docker.internal:host-gateway so
# the container can reach the host's app server (target_url uses
# host.docker.internal:<port>).

ENTRYPOINT ["python3", "/tester/run_po.py"]
