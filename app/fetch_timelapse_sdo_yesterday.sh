#!/bin/bash

# Sätt säkert katalogläge och avbryt scriptet om något går fel
set -e

# Gå till scriptets arbetskatalog
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || {
    echo "Kunde inte gå till app-mappen!"
    exit 1
}

# Räkna ut gårdagens datum i formatet YYYY-MM-DD
YESTERDAY=$(date -d "yesterday" +"%Y-%m-%d")

# Kör scriptet – utan citattecken runt argumentet
python fetch_timelapse.py $YESTERDAY >> /var/log/fetch_timelapse.log 2>&1
