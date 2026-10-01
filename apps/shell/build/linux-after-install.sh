#!/bin/sh
# deb/rpm post-install: expose the teleoffice command line shipped inside the app.
# Only an absent name, a dead link or a link into our own install dir is taken
# over; anything else at /usr/bin/teleoffice belongs to another program (genoffice#893).
set -e
launcher="/opt/GenOffice/resources/cli/teleoffice"
link="/usr/bin/teleoffice"
[ -x "$launcher" ] || exit 0
# the command was called genoffice before; drop that name when it is our link
legacy="/usr/bin/genoffice"
if [ -L "$legacy" ]; then
  case "$(readlink "$legacy")" in
    /opt/GenOffice/*) rm -f "$legacy" ;;
  esac
fi
if [ -L "$link" ]; then
  case "$(readlink "$link")" in
    /opt/GenOffice/*) ;;
    *) [ -e "$link" ] && { echo "teleoffice: $link is another program, left as is; run: ln -s $launcher $link" >&2; exit 0; } ;;
  esac
elif [ -e "$link" ]; then
  echo "teleoffice: $link is another program, left as is; run: ln -s $launcher $link" >&2
  exit 0
fi
ln -sfn "$launcher" "$link"
exit 0
