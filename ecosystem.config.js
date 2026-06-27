module.exports = {
  apps: [{
    name: 'cloud-drive',
    script: './server.js',
    cwd: '/www/wwwroot/cloud-drive',
    env: {
      NODE_ENV: 'production',
      CLOUD_DRIVE_ADMIN_KEY: 'cloud2024',
      // ===== 集群配置（取消注释并填写以启用集群模式） =====
      // CLUSTER_NODE_ID: 'node-shanghai',
      // CLUSTER_NODE_NAME: '上海主节点',
      // CLUSTER_SECRET: '<64位随机hex串>',
      // CLUSTER_PEERS: 'node-beijing::http://10.0.0.2:3002::<secret>',
      // CLUSTER_TIMEOUT: '5000',
      // CLUSTER_SIGNATURE_WINDOW: '300'
    },
    // 日志轮转
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/www/wwwroot/cloud-drive/logs/error.log',
    out_file: '/www/wwwroot/cloud-drive/logs/out.log',
    max_size: '10M',
    retain: 7,
    // 自动重启
    max_restarts: 10,
    restart_delay: 5000,
    // 监控
    instance_var: 'INSTANCE_ID',
    watch: false
  }]
};
