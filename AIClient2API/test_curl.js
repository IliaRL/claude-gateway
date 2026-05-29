const response = await fetch('http://localhost:3000/claude-kiro-oauth/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk-a60f3efdf9b97e63c84ab4a3583f9d1c',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    messages: [{role: "user", content: "hi"}]
  })
});

const data = await response.json();
console.log(JSON.stringify(data, null, 2));
