jest.mock('../src/models/User', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  getResetPasswordToken: jest.fn(),
}));

jest.mock('../src/config/jwt', () => ({
  generateAccessToken: jest.fn(() => 'access-token'),
  generateRefreshToken: jest.fn(() => 'refresh-token'),
  verifyRefreshToken: jest.fn(),
}));

jest.mock('../src/utils/sendEmail', () => jest.fn());

jest.mock('../src/services/remoteAccessService', () => ({
  buildResetPasswordUrl: jest.fn(),
  isSelfRegistrationAllowed: jest.fn(),
}));

const User = require('../src/models/User');
const sendEmail = require('../src/utils/sendEmail');
const remoteAccessService = require('../src/services/remoteAccessService');
const authController = require('../src/controllers/authController');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('auth controller remote access behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    remoteAccessService.isSelfRegistrationAllowed.mockReturnValue(true);
  });

  test('register rejects requests when self-registration is disabled', async () => {
    remoteAccessService.isSelfRegistrationAllowed.mockReturnValue(false);

    const res = createRes();
    await authController.register({
      body: {
        name: 'Trader',
        email: 'trader@example.com',
        password: 'Password123',
      },
    }, res);

    expect(User.create).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
    }));
    expect(res.payload.message).toContain('Self-registration is disabled');
  });

  test('getAuthConfig exposes the self-registration flag', async () => {
    remoteAccessService.isSelfRegistrationAllowed.mockReturnValue(false);

    const res = createRes();
    await authController.getAuthConfig({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        allowSelfRegistration: false,
      },
    });
  });

  test('forgotPassword builds reset URLs from the public base URL resolver', async () => {
    User.findOne.mockResolvedValue({
      _id: 'user-1',
      email: 'trader@example.com',
    });
    User.getResetPasswordToken.mockReturnValue({
      resetToken: 'plain-reset-token',
      resetPasswordToken: 'hashed-token',
      resetPasswordExpire: Date.now() + 600000,
    });
    User.findByIdAndUpdate.mockResolvedValue({});
    remoteAccessService.buildResetPasswordUrl.mockResolvedValue(
      'https://example.ngrok.app/reset-password/plain-reset-token'
    );
    sendEmail.mockResolvedValue({});

    const res = createRes();
    await authController.forgotPassword({
      body: {
        email: 'trader@example.com',
      },
    }, res);

    expect(remoteAccessService.buildResetPasswordUrl).toHaveBeenCalledWith('plain-reset-token');
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: 'trader@example.com',
      subject: 'QuantMatrix - Password Reset',
      html: expect.stringContaining('https://example.ngrok.app/reset-password/plain-reset-token'),
    }));
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      message: 'Password reset email sent',
    }));
  });
});
