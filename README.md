# Catan Game Backend

This is the backend server for the multiplayer Catan game. It serves both the API and the built frontend.

## Development

```bash
# Start backend in development mode
npm run dev

# Start frontend in development mode (in another terminal)
cd ../front && npm run dev
```

## Production Deployment

The backend serves the built frontend from the `public` folder.

### Build and Deploy

```bash
# Build frontend into backend's public folder
npm run build

# Start production server
npm start

# Or build and start in one command
npm run build:prod
```

### Manual Steps

1. Build the frontend:
   ```bash
   cd front
   npm run build
   ```

2. Start the backend:
   ```bash
   cd back
   npm start
   ```

The server will serve the React app at the root URL and handle all API routes and WebSocket connections.

## Environment Variables

Create a `.env` file in the backend directory:

```
PORT=3001
NODE_ENV=production
```

## Features

- **Static File Serving**: Serves built React app from `/public`
- **API Routes**: Game logic and WebSocket handling
- **CORS Configuration**: Automatic dev/prod CORS settings
- **React Router Support**: Catch-all route for client-side routing
