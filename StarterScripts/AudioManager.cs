using UnityEngine;

namespace GameJamCore
{
    public class AudioManager : MonoBehaviour
    {
        public static AudioManager Instance { get; private set; }

        [Header("Audio Sources")]
        [SerializeField] private AudioSource musicSource;
        [SerializeField] private AudioSource sfxSource;

        private void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }
            Instance = this;
            DontDestroyOnLoad(gameObject);

            if (musicSource == null) musicSource = gameObject.AddComponent<AudioSource>();
            if (sfxSource == null) sfxSource = gameObject.AddComponent<AudioSource>();

            musicSource.loop = true;
        }

        public void PlayBGM(AudioClip clip, float volume = 0.7f)
        {
            if (clip == null) return;
            musicSource.clip = clip;
            musicSource.volume = volume;
            musicSource.Play();
        }

        public void StopBGM()
        {
            musicSource.Stop();
        }

        public void PlaySFX(AudioClip clip, float volume = 1f, bool randomizePitch = true)
        {
            if (clip == null) return;
            if (randomizePitch)
            {
                sfxSource.pitch = Random.Range(0.9f, 1.1f);
            }
            else
            {
                sfxSource.pitch = 1f;
            }
            sfxSource.PlayOneShot(clip, volume);
        }
    }
}
