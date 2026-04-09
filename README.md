# QuantMatrix-MT5

Quantitative Trading Platform - Download and Run Edition

## Quick Start (Windows)

1. Download or clone this repository
2. Double-click `start.bat`
3. Done! The server runs at http://localhost:5000

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
```

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
