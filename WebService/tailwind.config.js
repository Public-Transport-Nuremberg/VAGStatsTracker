module.exports = {
  content: [
    './views/**/*.ejs',
    './public/dist/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        vag: {
          blue: '#005CA9',
          red: '#E3000B',
          green: '#008A4B',
          ink: '#1f2937',
        },
      },
      boxShadow: {
        panel: '0 12px 30px rgba(15, 23, 42, 0.14)',
      },
    },
  },
  plugins: [],
};
