import React from 'react';
import ReactDOM from 'react-dom/client';
import GameView from './components/GameView'; // Assuming GameView is the main component
import './index.css'; // Optional: Add a basic CSS reset or global styles

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GameView />
  </React.StrictMode>,
); 