#!/usr/bin/env bash
#
# Public Health Colosseum — one-line install.
#
#   curl -fsSL https://raw.githubusercontent.com/Maerih/phc-bot/main/install.sh | bash
#
# Fetches the bot from GitHub into ~/phc-bot (or updates it if it is already
# there), then hands over to ./ctl.sh start, which checks the machine, gets
# Docker, asks the setup questions, builds, starts and shows the QR code.
#
# Run it as root or as any user. Docker comes as the bot's own copy in its
# folder. As root, anything small that is missing (curl, iptables) is
# installed; as another user, start offers to set up what rootless Docker
# needs, through sudo. Options:
#   PHC_DIR=/path/to/folder   where to put it (default: ~/phc-bot)
#   PHC_REPO=<git url>        a fork or mirror (default: the GitHub repo)
#
set -euo pipefail

REPO="${PHC_REPO:-https://github.com/Maerih/phc-bot.git}"
DIR="${PHC_DIR:-$HOME/phc-bot}"

say() { printf '%s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is needed. An administrator installs it once:  sudo apt install git"

if [ -d "$DIR/.git" ]; then
	say "Updating the existing copy in $DIR ..."
	git -C "$DIR" pull --ff-only --quiet ||
		die "could not update $DIR from GitHub. If you changed files there, see:  git -C \"$DIR\" status"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
	die "$DIR already exists and is not a copy of the bot. Move it away, or choose another folder:  PHC_DIR=... "
else
	say "Downloading the bot into $DIR ..."
	git clone --quiet "$REPO" "$DIR"
fi
say "Version: $(git -C "$DIR" log -1 --format='%h — %s (%cr)')"

# When this script arrives through a pipe, its stdin is the pipe, not the
# keyboard. Reattach the terminal so the setup questions and the QR code work.
cd "$DIR"
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
	exec ./ctl.sh start </dev/tty >/dev/tty 2>&1
fi
exec ./ctl.sh start
