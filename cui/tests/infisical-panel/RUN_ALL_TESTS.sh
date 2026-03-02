#!/bin/bash
# Infisical Panel - Complete Test Suite Runner

echo "========================================"
echo "Infisical Panel Test Suite"
echo "========================================"
echo ""

FAILED=0

echo "[1/3] API Endpoint Tests"
echo "------------------------"
python3 tests/infisical-panel/test-api-endpoints.py
if [ $? -ne 0 ]; then
    FAILED=$((FAILED + 1))
fi

echo ""
echo "[2/3] UI Rendering Tests"
echo "------------------------"
python3 tests/infisical-panel/test-simple-load.py
if [ $? -ne 0 ]; then
    FAILED=$((FAILED + 1))
fi

echo ""
echo "[3/3] Integration Tests"
echo "------------------------"
python3 tests/infisical-panel/test-full-integration.py
if [ $? -ne 0 ]; then
    FAILED=$((FAILED + 1))
fi

echo ""
echo "========================================"
echo "Test Suite Complete"
echo "========================================"
echo ""

if [ $FAILED -eq 0 ]; then
    echo "✓ All test suites passed!"
    exit 0
else
    echo "✗ $FAILED test suite(s) failed"
    exit 1
fi
