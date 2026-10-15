using System;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GameJamCore
{
    public enum GameState
    {
        MainMenu,
        Playing,
        Paused,
        GameOver,
        Victory
    }

    public class GameManager : MonoBehaviour
    {
        public static GameManager Instance { get; private set; }

        public static event Action<GameState> OnStateChanged;

        [Header("Current Status")]
        [SerializeField] private GameState currentState = GameState.Playing;
        [SerializeField] private int currentScore = 0;

        public GameState CurrentState => currentState;
        public int Score => currentScore;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        public void ChangeState(GameState newState)
        {
            if (currentState == newState) return;

            currentState = newState;
            Debug.Log($"[GameManager] State changed to: {newState}");

            switch (newState)
            {
                case GameState.Playing:
                    Time.timeScale = 1f;
                    break;
                case GameState.Paused:
                case GameState.GameOver:
                case GameState.Victory:
                    Time.timeScale = 0f;
                    break;
            }

            OnStateChanged?.Invoke(newState);
        }

        public void AddScore(int amount)
        {
            currentScore += amount;
            Debug.Log($"[GameManager] Score updated: {currentScore}");
        }

        public void ResetScore()
        {
            currentScore = 0;
        }

        public void RestartCurrentScene()
        {
            Time.timeScale = 1f;
            currentScore = 0;
            currentState = GameState.Playing;
            SceneManager.LoadScene(SceneManager.GetActiveScene().buildIndex);
        }

        public void LoadSceneByName(string sceneName)
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene(sceneName);
        }
    }
}
