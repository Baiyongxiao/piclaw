#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo 'building project...'
npm run build

echo 'killing old next server...'
PID=$(ps aux | grep next-server | grep -v grep | awk '{print $2}')
[ -n "$PID" ] && kill -9 $PID
sleep 2

echo 'starting server...'
nohup node ./node_modules/.bin/next start -p 30141 >> /tmp/next.log 2>&1 &
sleep 3

NEW=$(ps aux | grep next-server | grep -v grep | awk '{print $2}' | head -1)
echo "server restarted, PID: $NEW"
curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:30141/
