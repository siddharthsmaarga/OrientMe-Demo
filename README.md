# OrientMe demo

This repository now contains the original OrientMe MVP source supplied from `Orient-Me/MVP Prototype/orientme-app`. Its Next.js pages and Django behavior are preserved; the deployment additions provide production settings for a company-network demo.

## What colleagues can open

- `/` is the original public search page and does not require login.
- Dashboard, Board, Settings, Profile, Statistics, Action Center, and topic pages retain the original login and permission behavior.
- The demo starts with a new empty SQLite database. No source database, uploads, API key, or account is included.

## Run on a company Windows host

The host must remain on and have Python 3.12-3.14, Node.js 20.9 or newer, and network access to install the app dependencies and fetch the app's existing Google Fonts during the build. Choose an IPv4 address on the host that NetExtender users can reach.

1. Check the address with `ipconfig`.
2. From this repository, run PowerShell:

   ```powershell
   .\deployment\start-vpn-demo.ps1 -BindAddress <company-host-ip>
   ```

3. Colleagues browse to `http://<company-host-ip>:3001/` while connected to the company network or NetExtender.
4. Stop both services from the repository root:

   ```powershell
   ./deployment/stop-vpn-demo.ps1
   ```

The launcher creates a local Python environment, installs dependencies, builds the frontend, migrates the empty database, generates a private Django key on the host, and starts both services bound to the selected address. It writes its key, database, uploads, logs, and process record only to ignored local paths. It does not change Windows Firewall rules. The host firewall and company network must allow TCP 3001 (web UI) and 8010 (API) from the VPN clients.

To enable the login-gated pages for a demo administrator, run this from the repository root and choose a unique temporary password:

```powershell
cd .\orientme-app\backend
$temporaryPassword = Read-Host 'Choose a temporary demo password'
.\.venv\Scripts\python.exe manage.py create_admin --username demo-admin --password $temporaryPassword
Remove-Variable temporaryPassword
cd ..\..
```

The password argument can be visible in local process listings and shell history; use a temporary credential and replace it after the demo. No account is created automatically.

## Hosting limits

GitHub Pages cannot run this Django backend. Pages deployment has been removed; the branch workflow creates a downloadable source package instead. The live app must run on a company-controlled computer or server reachable over the VPN. This demo uses HTTP and should remain on the company network/VPN; do not put confidential meeting data, provider keys, or production accounts into it.

The repository is public. It contains application source and deployment scripts only. Never commit the host's database, uploaded files, generated secret key, or provider credentials.
