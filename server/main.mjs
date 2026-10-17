import { createGameServer } from './server.mjs';

try {
  const game = await createGameServer();
  const address = await game.listen();
  console.log(`LEGOCRAFT is listening on http://${address.address === '0.0.0.0' ? '<raspberry-pi-ip>' : address.address}:${address.port}`);
  console.log('Open that address on devices connected to the same local network.');
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await game.close(); process.exit(0); } catch (error) { console.error('Unable to save multiplayer rooms:', error.message); process.exit(1); }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(`Unable to start LEGOCRAFT: ${error.message}`);
  process.exitCode = 1;
}
