/** Same-origin LAN transport. Rendering and game rules stay outside this class. */
export class MultiplayerSession {
  constructor({ onPacket, onDisconnect }) {
    this.onPacket = onPacket;
    this.onDisconnect = onDisconnect;
    this.socket = null;
    this.connected = false;
    this.playerId = null;
    this.roomCode = null;
    this.hostId = null;
    this.poseElapsed = 0;
    this.getInventory = () => ({});
    this.worldName = '';
    // This is a reconnect identity for a trusted home network, not an account.
    try { this.clientId = localStorage.getItem('legocraft-player-id'); } catch { /* Optional storage. */ }
    if (!/^[a-f0-9-]{16,64}$/i.test(this.clientId || '')) {
      this.clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('legocraft-player-id', this.clientId); } catch { /* Reconnect works within this tab. */ }
    }
  }

  connect(request) {
    this.close();
    return new Promise((resolve, reject) => {
      const url = new URL('/multiplayer', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        fail('The multiplayer server did not respond. Start the Node server on the Pi, then try again.');
        socket.close();
      }, 10000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ ...request, clientId: this.clientId })));
      socket.addEventListener('message', ({ data }) => {
        if (this.socket !== socket) return;
        let packet;
        try { packet = JSON.parse(data); } catch { return; }
        if (packet.type === 'welcome') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          this.playerId = packet.playerId;
          this.roomCode = packet.roomCode;
          this.hostId = packet.hostId;
          this.worldName = packet.world?.name || packet.state?.name || 'My world';
          resolve(packet);
        } else if (!settled && packet.type === 'error') {
          fail(packet.message);
          socket.close();
        } else if (this.connected) this.onPacket(packet);
      });
      socket.addEventListener('error', () => fail('Cannot reach multiplayer. Open the game through the Pi’s Node server, not a static-only server.'));
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        const wasConnected = this.connected;
        const roomCode = this.roomCode;
        this.connected = false;
        this.socket = null;
        fail('The multiplayer connection closed. Please try joining again.');
        if (wasConnected) this.onDisconnect(roomCode);
      });
    });
  }

  send(packet) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(packet));
    return true;
  }

  pose(player, active) {
    this.poseElapsed = 0;
    return this.send({ type: 'pose', x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, active, ...this.getInventory() });
  }

  update(dt, player, active) {
    this.poseElapsed += dt;
    if (this.poseElapsed >= 0.1) this.pose(player, active);
  }

  action(action, details = {}) { return this.send({ type: 'action', action, ...details }); }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.playerId = this.roomCode = this.hostId = null;
    socket?.close();
  }
}
