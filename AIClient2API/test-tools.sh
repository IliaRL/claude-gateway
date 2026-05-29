curl -s http://127.0.0.1:3000/v1/messages \
  -H "x-api-key: sk-a60f3efdf9b97e63c84ab4a3583f9d1c" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "gemini-claude-sonnet-4-6",
    "max_tokens": 1024,
    "tools": [{
      "name": "get_weather",
      "description": "Get weather",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        }
      }
    }],
    "messages": [
      {"role": "user", "content": "What is the weather?"}
    ]
  }'
