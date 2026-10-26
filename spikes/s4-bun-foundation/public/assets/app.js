const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = (e) => { document.getElementById("root").textContent = e.data; };
// S4-SPIKE-APPJS
