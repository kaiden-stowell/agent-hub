#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Agent Hub at http://127.0.0.1:12789"
node server.js
