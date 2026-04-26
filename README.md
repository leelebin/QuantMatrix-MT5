# QuantMatrix-MT5

Quantitative Trading Platform - Download and Run Edition

## Quick Start (Windows)

1. Download or clone this repository
2. Double-click `start.bat`
3. Done! The server runs at http://localhost:5000

For browser access from your phone over the public Internet, configure `NGROK_AUTHTOKEN` in `.env` and then run `start-remote.bat` instead.

**No pre-installation required.** The BAT file automatically:
- Downloads portable Node.js if not installed
- Installs all dependencies
- Creates configuration files
- Starts the server

## Features

- User registration and authentication (JWT)
- Access token + refresh token mechanism
- Password reset via email
- User profile management
- Rate limiting on auth endpoints
- Embedded database (NeDB) - no external database needed

## API Endpoints

### Authentication (`/api/auth`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout (requires auth) |
| POST | `/api/auth/refresh-token` | Refresh access token |
| POST | `/api/auth/forgot-password` | Request password reset |
| PUT | `/api/auth/reset-password/:token` | Reset password |

### User (`/api/users`) - All require authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/me` | Get current user profile |
| PUT | `/api/users/me` | Update profile |
| PUT | `/api/users/change-password` | Change password |

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server status |

## Configuration

Edit `.env` file to customize (auto-created on first run):

```env
PORT=5000                    # Server port
JWT_SECRET=...               # Auto-generated if not set
JWT_EXPIRE=24h               # Access token expiry
JWT_REFRESH_EXPIRE=7d        # Refresh token expiry
ALLOW_SELF_REGISTRATION=false
NGROK_AUTHTOKEN=...
REMOTE_URL_NOTIFY=true
```

## Remote Browser Access

Use `start-remote.bat` when you want the web UI to be reachable from your phone over the Internet.

What it does:
- Starts the local QuantMatrix server as usual
- Starts an `ngrok` HTTPS tunnel to your local dashboard
- Protects the public URL with outer Basic Auth before the app login page
- Sends the latest public URL to your configured Telegram when it changes

Before first use:
1. Put your `NGROK_AUTHTOKEN` into `.env`
2. Keep `ALLOW_SELF_REGISTRATION=false` for safer public exposure
3. If you need to create the first user account, temporarily switch `ALLOW_SELF_REGISTRATION=true`, create the account locally, then turn it off again

Password reset emails now prefer the active public tunnel URL when one is available, and fall back to the local `FRONTEND_URL` if not.

## File Structure

```
QuantMatrix-MT5/
├── start.bat              # One-click startup script
├── src/
│   ├── server.js          # Express app entry point
│   ├── config/
│   │   ├── db.js          # NeDB database setup
│   │   └── jwt.js         # JWT token utilities
│   ├── controllers/
│   │   ├── authController.js
│   │   └── userController.js
│   ├── middleware/
│   │   ├── auth.js        # JWT auth middleware
│   │   └── validate.js    # Input validation
│   ├── models/
│   │   └── User.js        # User data model
│   ├── routes/
│   │   ├── authRoutes.js
│   │   └── userRoutes.js
│   └── utils/
│       └── sendEmail.js   # Email utility
├── data/                  # Database files (auto-created)
├── .env                   # Configuration (auto-created)
└── package.json
```

## System Requirements

- **OS**: Windows 7/10/11, Windows Server (VPS)
- **Internet**: Required for first run only (downloads Node.js and dependencies)
- **Disk**: ~100MB (including portable Node.js)

## VPS Deployment

Works on Windows VPS out of the box. Just upload the folder and run `start.bat`.
For background execution on VPS, you can use:

```batch
:: Run in background using PowerShell
powershell -Command "Start-Process -WindowStyle Hidden cmd '/c start.bat'"
```

## License

ISC
