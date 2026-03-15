---
name: account-creation
description: Create new accounts on websites, generate secure passwords, set up TOTP, and manage credential files.
---

# Account Creation & Credential Management

This skill teaches you how to create accounts on websites, manage credentials stored as JSON files, and handle login flows.

## Credential File Storage

Credentials are stored as JSON files in the project's `credentials/` folder.

### Password credentials — `credentials/{domain}.json`

```json
{
  "type": "password",
  "label": "GitHub",
  "siteUrl": "github.com",
  "username": "user@example.com",
  "password": "the-password",
  "totpSecret": "BASE32SECRET",
  "backupCodes": ["code1", "code2"],
  "createdAt": "2026-03-15T00:00:00Z",
  "updatedAt": "2026-03-15T00:00:00Z"
}
```

### Passkey credentials — `credentials/{domain}.passkey.json`

```json
{
  "type": "passkey",
  "label": "GitHub Passkey",
  "siteUrl": "github.com",
  "credentialId": "...",
  "privateKey": "...",
  "rpId": "github.com",
  "userHandle": "...",
  "signCount": 5,
  "createdAt": "2026-03-15T00:00:00Z"
}
```

### Reading & writing credentials

- **Read:** `readFile("credentials/{domain}.json")`
- **Write:** `writeFile("credentials/{domain}.json", content)`
- **List:** `listFiles` in the `credentials/` folder

## Login Flow

When you encounter a login page, "session expired", or auth redirect:

1. Check `credentials/` for a matching domain file using `listFiles` then `readFile`
2. If a **passkey** credential exists:
   - Call `loadPasskey` with the site URL (load via `loadTools` first)
   - Click "Sign in with passkey" or equivalent
   - The virtual authenticator handles the rest
3. If a **password** credential exists:
   - Fill in the login form and submit
   - Handle 2FA (see below)
4. If **no credential** exists:
   - Ask the user if they want you to create an account

### Handling 2FA after password login

- **TOTP/Authenticator code** — Generate the code using Python (see snippet below). If `totpRemainingSeconds < 5`, wait and regenerate.
- **Email verification** — Navigate to the email provider, log in with its credential file, find the verification email, extract the code, switch back.
- **SMS code** — Ask the user to provide it in chat.
- **Push/app approval** — Ask the user to approve on their device.
- **Backup code** — Enter a backup code from the credential file. After using it, update the file to remove the used code.

## Account Creation Flow

When asked to create an account on a website:

1. Navigate to the signup page
2. Fill in the registration form:
   - Use the email/username the user specifies
   - Generate a secure password using Python (see snippet below)
3. Submit the form, handle any verification steps
4. **Immediately save the credential file** via `writeFile("credentials/{domain}.json", ...)`
5. Optionally set up TOTP:
   - Navigate to security settings
   - Click "manual entry key" or "can't scan QR code" to get the base32 secret
   - Add `totpSecret` to the credential file
   - Generate and enter the first TOTP code to verify
6. Optionally register a passkey:
   - Navigate to the site's passkey/security key settings and click "Register"
   - The virtual authenticator handles registration automatically
   - Call `savePasskeyCredential` to export and save the passkey
7. If backup codes are shown, add them to the credential file

## Python Code Snippets

### Password generation

```python
import secrets, string
chars = string.ascii_letters + string.digits + '!@#$%^&*()'
password = ''.join(secrets.choice(chars) for _ in range(20))
print(password)
```

### TOTP code generation

```python
import hmac, hashlib, struct, time, base64

def generate_totp(secret_b32):
    key = base64.b32decode(secret_b32.upper())
    counter = struct.pack('>Q', int(time.time()) // 30)
    mac = hmac.new(key, counter, hashlib.sha1).digest()
    offset = mac[-1] & 0x0f
    code = struct.unpack('>I', mac[offset:offset+4])[0] & 0x7fffffff
    remaining = 30 - (int(time.time()) % 30)
    return str(code % 10**6).zfill(6), remaining

# Usage: read totpSecret from the credential file
code, remaining = generate_totp("BASE32SECRET")
print(f"Code: {code} (valid for {remaining}s)")
```

## Important Rules

- **Never log or display passwords or passkey keys.** Refer to credentials as "your saved login".
- Always save credential files immediately after account creation — don't wait until the end.
- When a backup code is used, update the credential file to remove it right away.
- For OAuth/social login, click the button, then use the credential file for the OAuth provider's domain.
