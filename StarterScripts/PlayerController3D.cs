using UnityEngine;

namespace GameJamCore
{
    [RequireComponent(typeof(CharacterController))]
    public class PlayerController3D : MonoBehaviour
    {
        [Header("Movement Settings")]
        [SerializeField] private float moveSpeed = 6f;
        [SerializeField] private float sprintSpeed = 9f;
        [SerializeField] private float jumpHeight = 1.5f;
        [SerializeField] private float gravity = -19.62f;

        [Header("Camera & Rotation")]
        [SerializeField] private Transform cameraTransform;
        [SerializeField] private float rotationSmoothTime = 0.1f;

        private CharacterController controller;
        private Vector3 velocity;
        private bool isGrounded;
        private float currentVelocity;

        private void Start()
        {
            controller = GetComponent<CharacterController>();
            if (cameraTransform == null && Camera.main != null)
            {
                cameraTransform = Camera.main.transform;
            }
        }

        private void Update()
        {
            // Only move during active gameplay
            if (GameManager.Instance != null && GameManager.Instance.CurrentState != GameState.Playing)
            {
                return;
            }

            // Ground Check
            isGrounded = controller.isGrounded;
            if (isGrounded && velocity.y < 0)
            {
                velocity.y = -2f;
            }

            // Read standard Input
            float horizontal = Input.GetAxisRaw("Horizontal");
            float vertical = Input.GetAxisRaw("Vertical");
            Vector3 direction = new Vector3(horizontal, 0f, vertical).normalized;

            bool isSprinting = Input.GetKey(KeyCode.LeftShift);
            float currentSpeed = isSprinting ? sprintSpeed : moveSpeed;

            if (direction.magnitude >= 0.1f)
            {
                float targetAngle = Mathf.Atan2(direction.x, direction.z) * Mathf.Rad2Deg;
                if (cameraTransform != null)
                {
                    targetAngle += cameraTransform.eulerAngles.y;
                }

                float angle = Mathf.SmoothDampAngle(transform.eulerAngles.y, targetAngle, ref currentVelocity, rotationSmoothTime);
                transform.rotation = Quaternion.Euler(0f, angle, 0f);

                Vector3 moveDir = Quaternion.Euler(0f, targetAngle, 0f) * Vector3.forward;
                controller.Move(moveDir.normalized * currentSpeed * Time.deltaTime);
            }

            // Jump
            if (Input.GetButtonDown("Jump") && isGrounded)
            {
                velocity.y = Mathf.Sqrt(jumpHeight * -2f * gravity);
            }

            // Apply Gravity
            velocity.y += gravity * Time.deltaTime;
            controller.Move(velocity * Time.deltaTime);
        }
    }
}
