# Code Signing Certificate Setup

## SECURITY: Code Signing Required

This application now requires code signing to prevent supply chain attacks and ensure update integrity.

## Steps to Enable Code Signing

### 1. Obtain a Windows Code Signing Certificate

Purchase from a trusted Certificate Authority (CA):
- **DigiCert** (recommended): https://www.digicert.com/code-signing/microsoft-authenticode-certificates
- **Sectigo**: https://sectigo.com/ssl-certificates-tls/code-signing
- **SSL.com**: https://www.ssl.com/certificates/code-signing/

**Cost:** ~$200-400/year
**Validation Time:** 1-7 business days

### 2. Export Certificate to PFX Format

After receiving your certificate:
1. Open Windows Certificate Manager (`certmgr.msc`)
2. Find your code signing certificate under "Personal > Certificates"
3. Right-click → All Tasks → Export
4. Choose "Yes, export the private key"
5. Select "Personal Information Exchange (.PFX)"
6. Set a strong password
7. Save as `certificate.pfx`

### 3. Place Certificate in This Directory

```
pos-system/build/certs/certificate.pfx
```

**IMPORTANT:** This file contains your private key. Never commit it to git!

### 4. Set Environment Variable

Set the certificate password as an environment variable:

```powershell
# Windows PowerShell
$env:CSC_KEY_PASSWORD = "your-certificate-password"

# Or add to system environment variables permanently
```

For CI/CD (GitHub Actions), add as a secret:
- Secret name: `CSC_KEY_PASSWORD`
- Secret value: your certificate password

### 5. Build Signed Application

```bash
npm run dist:win
```

The build process will now sign:
- The main executable
- All DLL files
- The installer (NSIS)
- Update packages

## Verification

After building, verify the signature:

```powershell
# Check if executable is signed
signtool verify /pa "release\The-Small-POS-Setup-1.1.38.exe"
```

You should see: "Successfully verified"

## Security Notes

- **Never commit certificate.pfx to git** (already in .gitignore)
- Store password in password manager (1Password, LastPass, etc.)
- Renew certificate before expiration
- If certificate is compromised, revoke immediately and obtain new one
- Different certificate needed for macOS (Apple Developer ID)

## Temporary Workaround (Development Only)

If you cannot obtain a certificate immediately:

1. Edit `package.json` line 159
2. Change `"verifyUpdateCodeSignature": true` to `false`
3. **NEVER use this in production**
4. **NEVER distribute unsigned builds to users**

## Cost-Benefit Analysis

**Without Code Signing:**
- ❌ Updates can be hijacked by attackers
- ❌ Malware can be injected into installers
- ❌ Windows SmartScreen warnings for users
- ❌ Potential PCI-DSS compliance issues

**With Code Signing:**
- ✅ Verified updates from trusted publisher
- ✅ Prevents supply chain attacks
- ✅ Professional appearance (no security warnings)
- ✅ Regulatory compliance
- **Cost:** $200-400/year (negligible for business)

## Questions?

Contact your security team or see:
- https://www.electronjs.org/docs/latest/tutorial/code-signing
- https://docs.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools
