import { createServer } from 'node:http';
import { handle } from './app.js';

const port = Number(process.env.PORT) || 3000;
createServer(handle).listen(port, () => {
  console.log(`api-hub listening on http://localhost:${port}`);
});
