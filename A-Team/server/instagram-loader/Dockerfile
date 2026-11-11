FROM node:24-alpine
RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv /opt/instagram-python
WORKDIR /app
COPY requirements.txt ./
RUN /opt/instagram-python/bin/pip install --no-cache-dir -r requirements.txt
COPY --chown=node:node *.js *.py package.json ./
RUN mkdir -p /app/private && chown node:node /app/private
ENV HOST=0.0.0.0 PORT=3100 IG_SOURCE=instaloader IG_PYTHON=/opt/instagram-python/bin/python IG_NEWS_ACCOUNT=antipov__team IG_NEWS_HASHTAG=новости
USER node
EXPOSE 3100
CMD ["node", "server.js"]
