FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends asterisk asterisk-modules asterisk-core-sounds-en gettext-base \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/asterisk/*.conf
COPY extensions.conf rtp.conf logger.conf modules.conf pjsip.conf.template /etc/asterisk/
COPY entrypoint.sh /entrypoint.sh
RUN printf '[options]\nrunuser=asterisk\nrungroup=asterisk\n' > /etc/asterisk/asterisk.conf \
 && chown -R asterisk:asterisk /etc/asterisk
EXPOSE 5060/udp 10000-10100/udp
ENTRYPOINT ["/entrypoint.sh"]
