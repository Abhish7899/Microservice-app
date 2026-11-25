FROM nginxinc/nginx-unprivileged:alpine

# Copy custom Nginx non-root configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy frontend static application assets
COPY index.html /usr/share/nginx/html/index.html

# Expose unprivileged non-root HTTP port
EXPOSE 8080

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
