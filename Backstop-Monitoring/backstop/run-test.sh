#!/bin/bash

cd /root/backstop || exit

WEBHOOK="YOUR_SLACK_WEBHOOK_HERE"

SITE_NAME="Crash Test Client"
REPORT_URL="https://backstop.webmarketersdev.ca"

RESULT=$(backstop test 2>&1)

rm -rf /var/www/backstop/*
cp -r /root/backstop/backstop_data/html_report /var/www/backstop/
cp -r /root/backstop/backstop_data/bitmaps_reference /var/www/backstop/
cp -r /root/backstop/backstop_data/bitmaps_test /var/www/backstop/

# 🔥 FORCE overwrite (with debug)
echo "Replacing index.html..."
cp -f /root/backstop/custom-index.html /var/www/backstop/html_report/index.html

# 🔍 Verify
ls -la /var/www/backstop/html_report/index.html

chown -R www-data:www-data /var/www/backstop
chmod -R 755 /var/www/backstop

if echo "$RESULT" | grep -q "Mismatch errors found"; then

  DIFF=$(echo "$RESULT" | grep -oP 'content: \K[0-9.]+(?=%)' | head -1)
  [ -z "$DIFF" ] && DIFF="unknown"

  curl -s -X POST -H 'Content-type: application/json' \
  --data "{
    \"text\": \"🚨 *Visual Changes Detected*\nClient: $SITE_NAME\nDifference: ${DIFF}%\nView Report: $REPORT_URL\"
  }" \
  $WEBHOOK

else
  echo "✅ No visual issues detected at $(date)"
fi
