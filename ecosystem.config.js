module.exports = {
	apps: [
		{
			name: 'telegram-ride-stat',
			script: './top.js',
			cwd: '/Users/mac/WebstormProjects/telegram-ride-stat',
			exec_mode: 'fork',
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: '512M',
			env: {
				NODE_ENV: 'production',
			},
		},
	],
}
