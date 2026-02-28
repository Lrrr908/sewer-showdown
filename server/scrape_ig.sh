#!/bin/bash
# Scrape recent IG posts for each artist and insert into the database
# Uses curl + jq to avoid Node rate-limit fingerprinting

DB="postgres://sewer:showdown@localhost:5432/sewer_showdown"
MAX_POSTS=3
DELAY=3

# Get all active artists
ARTISTS=$(psql "$DB" -t -A -c "SELECT id || '|' || ig_handle FROM artists WHERE is_active = TRUE AND ig_handle IS NOT NULL ORDER BY sort_order, id;")

TOTAL=0
SKIPPED=0
DONE=0

for LINE in $ARTISTS; do
  AID=$(echo "$LINE" | cut -d'|' -f1)
  HANDLE=$(echo "$LINE" | cut -d'|' -f2)
  
  echo -n "[$AID] @$HANDLE ... "
  
  # Fetch profile JSON via IG web API
  JSON=$(curl -s -w "\n%{http_code}" \
    -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
    -H "X-IG-App-ID: 936619743392459" \
    -H "Accept: application/json" \
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=${HANDLE}" 2>/dev/null)
  
  HTTP_CODE=$(echo "$JSON" | tail -1)
  BODY=$(echo "$JSON" | sed '$d')
  
  if [ "$HTTP_CODE" != "200" ]; then
    echo "SKIP (HTTP $HTTP_CODE)"
    SKIPPED=$((SKIPPED + 1))
    sleep $DELAY
    continue
  fi
  
  # Extract posts using python3 (more reliable than jq for nested JSON)
  POSTS=$(echo "$BODY" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    user = d.get('data',{}).get('user',{})
    edges = user.get('edge_owner_to_timeline_media',{}).get('edges',[])
    for e in edges[:${MAX_POSTS}]:
        n = e['node']
        sc = n.get('shortcode','')
        thumb = n.get('thumbnail_src','') or n.get('display_url','')
        if sc and thumb:
            print(f'{sc}\t{thumb}')
except:
    pass
" 2>/dev/null)
  
  if [ -z "$POSTS" ]; then
    echo "0 posts found"
    sleep $DELAY
    continue
  fi
  
  COUNT=0
  while IFS=$'\t' read -r SC THUMB; do
    POST_URL="https://www.instagram.com/p/${SC}/"
    psql "$DB" -q -c "
      INSERT INTO ig_posts (artist_id, post_url, manual_thumb_url, created_at, updated_at)
      VALUES ('${AID}', '${POST_URL}', '${THUMB}', now(), now())
      ON CONFLICT (post_url) DO UPDATE SET
        manual_thumb_url = EXCLUDED.manual_thumb_url,
        updated_at = now();
    " 2>/dev/null
    COUNT=$((COUNT + 1))
  done <<< "$POSTS"
  
  echo "${COUNT} posts"
  TOTAL=$((TOTAL + COUNT))
  DONE=$((DONE + 1))
  
  sleep $DELAY
done

echo ""
echo "=== DONE: ${DONE} artists, ${TOTAL} posts inserted, ${SKIPPED} skipped ==="
