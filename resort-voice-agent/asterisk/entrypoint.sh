#!/bin/sh
set -eu
: "${SIP_HOST:?defina SIP_HOST}" "${SIP_USERNAME:?defina SIP_USERNAME}" "${SIP_PASSWORD:?defina SIP_PASSWORD}"
: "${PUBLIC_IP:?defina PUBLIC_IP (IP público do servidor)}" "${ASTERISK_SECRET:?defina ASTERISK_SECRET}"
export ATENDIA_URL="${ATENDIA_URL:-http://app:8080}" AUDIOSOCKET_ADDR="${AUDIOSOCKET_ADDR:-app:9092}"
export DEFAULT_DID="${DEFAULT_DID:-}" DIAL_PREFIX="${DIAL_PREFIX:-+}"
envsubst '${SIP_HOST} ${SIP_USERNAME} ${SIP_PASSWORD} ${PUBLIC_IP}' < /etc/asterisk/pjsip.conf.template > /etc/asterisk/pjsip.conf
chown asterisk:asterisk /etc/asterisk/pjsip.conf && chmod 600 /etc/asterisk/pjsip.conf
exec asterisk -f -U asterisk -G asterisk -vvv
