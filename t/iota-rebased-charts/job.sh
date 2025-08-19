#!/bin/bash

API_URL="https://graphql.mainnet.iota.cafe"
OUTPUT_FILE="data.csv"

response1=$(curl -s "$API_URL" -H "Content-Type: application/json" -d '{"query": "{epoch {epochId}}"}')

epochId=$(echo "$response1" | jq -r '.data.epoch.epochId')
epochId=$((epochId - 1))

response2=$(curl -s "$API_URL" -H "Content-Type: application/json" -d "{\"query\": \"{epoch(id: $epochId) {totalTransactions totalStakeRewards totalGasFees iotaTotalSupply}}\"}")

if [ $? -ne 0 ]; then
    echo "Error: Failed to fetch data from API."
    exit 1
fi
yesterday=$(date -d "yesterday" +%Y-%m-%d)
#yesterday=$(date -v -1d +%Y-%m-%d) # for mac

echo -e "\n$response2" | jq -r --arg date "$yesterday" --arg epochId "$epochId" '.data.epoch | to_entries | map(.value) | [$date, $epochId] + . | join(",")' >> "$OUTPUT_FILE"

if [ $? -ne 0 ]; then
    echo "Error: Failed to parse JSON response."
    exit 1
fi

echo "Data for $yesterday successfully updated in $OUTPUT_FILE"