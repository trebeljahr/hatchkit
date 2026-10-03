#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root on the Docker host.' >&2; exit 1; }
command -v restic >/dev/null || { echo 'Install restic from the OS package repository first.' >&2; exit 1; }
command -v python3 >/dev/null
command -v docker >/dev/null
cd "$(dirname "$0")"
python3 runner.py plan --config ./config.json >/dev/null
install -d -m 700 /etc/hatchkit-backups /opt/hatchkit-backups /var/lib/hatchkit-backups
if [ -e /etc/hatchkit-backups/config.json ]; then
  cmp -s config.json /etc/hatchkit-backups/config.json || {
    echo 'Existing host policy differs; review and update it explicitly before reinstalling.' >&2
    exit 1
  }
else
  install -m 600 config.json /etc/hatchkit-backups/config.json
fi
install -m 700 runner.py /opt/hatchkit-backups/runner.py
install -m 700 register.py /opt/hatchkit-backups/register.py
install -m 700 restore-check.py /opt/hatchkit-backups/restore-check.py
install -m 644 hatchkit-backups.service hatchkit-backups.timer /etc/systemd/system/
systemctl daemon-reload
echo 'Installed. Store credentials, initialize each repository, run and verify a backup, then enable hatchkit-backups.timer.'
echo 'Rollback: systemctl disable --now hatchkit-backups.timer (keeps stored backups).'
