#!/usr/bin/env bash

curl -f http://localhost:8080/health || exit 1
curl -f http://localhost:8080/ready || echo "degraded"

echo "system check complete"
